package service

import (
	"context"
	"errors"
	"sort"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/pkg/units"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ReceiptInput — body POST /api/v1/stock/receipts.
//
// v2.0.87 (атомарная приёмка): если AccountID задан И Paid=true (default),
// то в той же транзакции создаётся financial_operation
// (type="out", category="stock_purchase", source_ref="receipt:<id>") и
// списывается баланс счёта. Без AccountID или с Paid=false —
// финоперация НЕ создаётся (кредиторская задолженность, оплатим позже).
type ReceiptInput struct {
	SupplierID   *string       `json:"supplier_id,omitempty"`
	SupplierName *string       `json:"supplier_name,omitempty"`
	Date         string        `json:"date,omitempty"` // YYYY-MM-DD, default — today
	Note         *string       `json:"note,omitempty"`
	PaymentType  string        `json:"payment_type"` // paid | credit
	PaidAmount   string        `json:"paid_amount,omitempty"`
	DueDate      *string       `json:"due_date,omitempty"`
	AccountID    *string       `json:"account_id,omitempty"` // если указан + Paid → атомарный finop
	Paid         *bool         `json:"paid,omitempty"`       // default true
	Lines        []ReceiptLine `json:"lines"`
}

// ReceiptLine — позиция приёмки.
type ReceiptLine struct {
	IngredientID string  `json:"ingredient_id"`
	Name         string  `json:"name"` // snapshot для печати
	Qty          string  `json:"qty"`
	Unit         *string `json:"unit,omitempty"`
	PricePerUnit string  `json:"price_per_unit"`
}

// WriteoffInput — body POST /api/v1/stock/writeoffs.
type WriteoffInput struct {
	Reason      string         `json:"reason"`
	Description *string        `json:"description,omitempty"`
	Lines       []WriteoffLine `json:"lines"`
}

// WriteoffLine — позиция списания. Стоимость считается как qty * price_per_unit
// или передаётся явно (например для FIFO/средневзвешенной — будет в Phase 4).
type WriteoffLine struct {
	IngredientID string  `json:"ingredient_id"`
	Name         string  `json:"name"`
	Qty          string  `json:"qty"`
	Unit         *string `json:"unit,omitempty"`
	Cost         string  `json:"cost"`
	// Kind — тип списываемого: "ingredient" (по умолчанию), "semi"
	// (полуфабрикат → semi_finished_stock), "batch" (готовое blюдо →
	// menu_items.prepared_qty). Раньше поля не было: строки semi/batch писались
	// как ingredient-движение с чужим id → хук денорма находил 0 строк, остаток
	// не уменьшался (тихий no-op). IngredientID для semi/batch несёт их id.
	Kind string `json:"kind,omitempty"`
}

// WithPublisher (как в других сервисах).
func (s *StockService) WithPublisher(pub *EventPublisher) *StockService {
	s.pub = pub
	return s
}

// CreateReceipt принимает товар. Создаёт:
//   - stock_receipts (header)
//   - stock_receipt_lines (детали)
//   - stock_movements с положительным qty (тип "receipt") — для каждой строки.
//
// Всё в одной транзакции. Идемпотентность middleware — на уровне HTTP.
func (s *StockService) CreateReceipt(ctx context.Context, in ReceiptInput) (*models.StockReceipt, error) {
	if err := requirePermFor(ctx, s.r, "inventory.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if len(in.Lines) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "at least one line required", nil)
	}
	if in.PaymentType == "" {
		in.PaymentType = "paid"
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()
	date := in.Date
	if date == "" {
		date = now.Format("2006-01-02")
	}

	// Парсинг и validation полей.
	totalAmount := decimal.Zero
	paid := decimal.Zero
	if in.PaidAmount != "" {
		paid, err = decimal.FromString(in.PaidAmount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad paid_amount", err)
		}
	}

	// Pre-parse lines, чтобы знать total_amount до Save заголовка.
	parsedLines := make([]struct {
		in   ReceiptLine
		qty  decimal.Decimal
		ppu  decimal.Decimal
		line decimal.Decimal
	}, len(in.Lines))
	for i, l := range in.Lines {
		qty, err := decimal.FromString(l.Qty)
		if err != nil || !decimal.IsPositive(qty) {
			return nil, apperrors.Wrap("VALIDATION", "bad qty in line", err)
		}
		ppu, err := decimal.FromString(l.PricePerUnit)
		if err != nil || decimal.IsNegative(ppu) {
			return nil, apperrors.Wrap("VALIDATION", "bad price_per_unit", err)
		}
		line := decimal.Normalize(decimal.Mul(qty, ppu))
		parsedLines[i] = struct {
			in   ReceiptLine
			qty  decimal.Decimal
			ppu  decimal.Decimal
			line decimal.Decimal
		}{l, qty, ppu, line}
		totalAmount = decimal.Add(totalAmount, line)
	}
	totalAmount = decimal.Normalize(totalAmount)
	// Н14: строки без ingredient_id — «услуги/доставка» (форма: «без учёта на
	// складе»). Деньги уходят, но склад не пополняют. Их стоимость — НЕ
	// stock_purchase (иначе она выпадает из ОПиУ: не COGS и не opex), а
	// операционный расход. Считаем эту часть отдельно, чтобы ниже развести
	// оплату на товарную часть (stock_purchase) и услуги (расход).
	serviceTotal := decimal.Zero
	for _, pl := range parsedLines {
		if pl.in.IngredientID == "" {
			serviceTotal = decimal.Add(serviceTotal, pl.line)
		}
	}
	serviceTotal = decimal.Normalize(serviceTotal)
	debt := decimal.Normalize(decimal.Sub(totalAmount, paid))
	if in.PaymentType == "paid" {
		paid = totalAmount
		debt = decimal.Zero
	}
	// Долг без поставщика предъявить некому: ниже current_debt начисляется только
	// при известном supplier_id, поэтому такой долг оставался невидимым для
	// пассивов, а возврат по такой накладной попадал в тупик — гасить не на кого,
	// а деньгами нельзя (за товар не платили). Запрещаем на входе.
	if decimal.IsPositive(debt) && (in.SupplierID == nil || *in.SupplierID == "") {
		return nil, apperrors.Wrap("VALIDATION", "накладная в долг требует поставщика: долг не на кого записать", nil)
	}

	var created *models.StockReceipt
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		receiptID := uuid.NewString()
		confirmedBy := actor.UserID
		pt := in.PaymentType
		receipt := &models.StockReceipt{
			ID:           receiptID,
			SupplierID:   in.SupplierID,
			SupplierName: in.SupplierName,
			Date:         &date,
			Note:         in.Note,
			TotalAmount:  totalAmount,
			PaymentType:  &pt,
			PaidAmount:   paid,
			DebtAmount:   debt,
			DueDate:      in.DueDate,
			ConfirmedAt:  &now,
			ConfirmedBy:  &confirmedBy,
			RestaurantID: &rid,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(receipt).Error; err != nil {
			return err
		}

		// Счёт — под замком и ДО ингредиентов: канонический порядок замков
		// (см. orders_perms.go) — поставщик → накладная → счёт → ингредиенты.
		// Сам списываем баланс ниже, но замок обязан быть взят здесь.
		var acc *models.FinancialAccount
		if in.AccountID != nil && *in.AccountID != "" && decimal.IsPositive(paid) {
			var a models.FinancialAccount
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, *in.AccountID).First(&a).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "account not found", err)
			}
			if !a.IsEnabled {
				return apperrors.Wrap("CONFLICT", "счёт отключён — выберите другой счёт", nil)
			}
			acc = &a
		}

		// Подгружаем (с блокировкой строк) ингредиенты позиций: нужны единица
		// склада + текущие qty/price для конвертации прихода и средневзвешенной
		// себестоимости. Lock защищает read-modify-write цены от потери при
		// параллельных приёмках того же ингредиента. Порядок id ASC — без него
		// две приёмки с пересекающимися позициями возьмут замки в разном порядке.
		ingByID := make(map[string]*models.Ingredient)
		{
			ids := make([]string, 0, len(parsedLines))
			seen := make(map[string]struct{})
			for _, pl := range parsedLines {
				if pl.in.IngredientID == "" {
					continue
				}
				if _, ok := seen[pl.in.IngredientID]; !ok {
					seen[pl.in.IngredientID] = struct{}{}
					ids = append(ids, pl.in.IngredientID)
				}
			}
			if len(ids) > 0 {
				var ings []models.Ingredient
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
					Where("restaurant_id = ? AND id IN ?", rid, ids).
					Order("id").Find(&ings).Error; err != nil {
					return err
				}
				for i := range ings {
					ingByID[ings[i].ID] = &ings[i]
				}
			}
		}

		for _, pl := range parsedLines {
			lineID := uuid.NewString()
			rl := &models.StockReceiptLine{
				ID:           lineID,
				ReceiptID:    &receiptID,
				IngredientID: &pl.in.IngredientID,
				Name:         &pl.in.Name,
				Qty:          pl.qty,
				Unit:         pl.in.Unit,
				PricePerUnit: pl.ppu,
				CreatedAt:    now,
				UpdatedAt:    now,
			}
			if err := tx.Create(rl).Error; err != nil {
				return err
			}

			// Единица склада ингредиента + конвертация прихода в неё
			// (приход в г при складе в кг → кг). qty движения = в единице склада,
			// иначе ingredients.qty денормализуется неверно.
			ing := ingByID[pl.in.IngredientID]
			stockUnit := ""
			if ing != nil && ing.Unit != nil {
				stockUnit = *ing.Unit
			}
			stockQty := units.Convert(pl.qty, deref(pl.in.Unit), stockUnit)
			mvUnit := pl.in.Unit
			if stockUnit != "" {
				mvUnit = &stockUnit
			}

			// stock_movement +qty (в единице склада)
			mvType := "receipt"
			desc := "receipt:" + receiptID
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &mvType,
				IngredientID:   &pl.in.IngredientID,
				IngredientName: &pl.in.Name,
				Description:    &desc,
				Qty:            stockQty,
				Unit:           mvUnit,
				RestaurantID:   &rid,
				CreatedAt:      now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}

			// Средневзвешенная себестоимость:
			//   new = (old_qty*old_price + line_cost) / (old_qty + recv_qty).
			// line_cost (pl.line) = qty * price_per_unit в единицах накладной —
			// инвариантно к конвертации единиц.
			if ing != nil && decimal.IsPositive(stockQty) {
				denom := decimal.Add(ing.Qty, stockQty)
				var newPrice decimal.Decimal
				if decimal.IsPositive(denom) && !decimal.IsNegative(ing.Qty) {
					newPrice = decimal.DivRound(decimal.Add(decimal.Mul(ing.Qty, ing.PricePerUnit), pl.line), denom)
				} else {
					// Остаток был отрицательным/нулевым — историческая стоимость
					// невалидна (напр. ушёл в минус при выключенном контроле остатков),
					// поэтому смешивать нельзя: берём чистую цену прихода. Без проверки
					// ing.Qty<0 средневзвешенная давала отрицательную с/с (−5*100+200)/5.
					newPrice = decimal.DivRound(pl.line, stockQty)
				}
				newPrice = decimal.Normalize(newPrice)
				if err := tx.Model(&models.Ingredient{}).
					Where("restaurant_id = ? AND id = ?", rid, pl.in.IngredientID).
					Update("price_per_unit", newPrice).Error; err != nil {
					return err
				}
				if err := recordIngredientSync(tx, []string{pl.in.IngredientID}); err != nil {
					return err
				}
				// In-memory обновление для следующих строк того же ингредиента.
				ing.Qty = denom
				ing.PricePerUnit = newPrice
			}
		}
		// Атомарный финоп (v2.0.87): списываем со счёта ОПЛАЧЕННУЮ СЕЙЧАС часть
		// (`paid`: для 'paid' = total, 'partial' = paid_amount, 'credit' = 0).
		// Раньше гейт был на `in.Paid` (bool) и списывался ВЕСЬ total: частичная
		// оплата не списывала ничего (paid=false), а при in.Paid+partial могла
		// переплатить. Теперь драйвер — рассчитанная сумма `paid`.
		// source_ref="receipt:<id>" + UNIQUE(restaurant_id, source_ref) → идемпотентность.
		// FOR UPDATE взят выше: ниже read-modify-write абсолютного баланса. Без
		// блокировки две параллельные операции по одному счёту читают одинаковый
		// старый баланс и вторая затирает первую — деньги пропадают. Приёмка была
		// единственным местом в финансах без этой блокировки (ср. PayDebt,
		// возврат, finance.go), и возврат добавил ей конкурента за тот же balance.
		if acc != nil {
			newBal := decimal.Normalize(decimal.Sub(acc.Balance, paid))
			if decimal.IsNegative(newBal) {
				return apperrors.Wrap("CONFLICT", "insufficient funds on account", nil)
			}
			if err := tx.Model(acc).Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
				return err
			}
			// Н14: делим оплату на товарную часть (stock_purchase, станет COGS при
			// продаже) и услуги/доставку (операционный расход, виден в ОПиУ сразу).
			// Пропорционально, т.к. paid может быть меньше total (частичная оплата);
			// при полной оплате servicePaid == serviceTotal. Баланс уже списан на
			// весь paid — ниже только две записи-проводки на его части.
			servicePaid := decimal.Zero
			if decimal.IsPositive(serviceTotal) && decimal.IsPositive(totalAmount) {
				servicePaid = decimal.Normalize(decimal.DivRound(decimal.Mul(paid, serviceTotal), totalAmount))
				if servicePaid.GreaterThan(paid) {
					servicePaid = paid
				}
			}
			goodsPaid := decimal.Normalize(decimal.Sub(paid, servicePaid))

			opType := "out"
			opActivity := "operational"
			opDate := date
			isAuto := true
			accID := *in.AccountID
			ridStr := rid
			desc := "Приёмка"
			if in.SupplierName != nil && *in.SupplierName != "" {
				desc = "Приёмка от " + *in.SupplierName
			}
			// Товарная часть → stock_purchase. Создаём, если есть товарная оплата
			// ЛИБО вся накладная товарная (serviceTotal==0) — чтобы нулевые
			// (полностью в долг) товарные приёмки поведения не меняли.
			if decimal.IsPositive(goodsPaid) || serviceTotal.IsZero() {
				opCat := "stock_purchase"
				opSrc := "receipt:" + receiptID
				finOp := &models.FinancialOperation{
					ID:           uuid.NewString(),
					Type:         &opType,
					Amount:       goodsPaid,
					Category:     &opCat,
					AccountID:    &accID,
					AccountName:  acc.Name,
					Activity:     &opActivity,
					Date:         &opDate,
					Description:  &desc,
					Counterparty: in.SupplierName,
					IsAuto:       &isAuto,
					SourceRef:    &opSrc,
					RestaurantID: &ridStr,
					CreatedBy:    actorIDPtr(ctx),
					CreatedAt:    now,
					UpdatedAt:    now,
				}
				if err := tx.Create(finOp).Error; err != nil {
					return err
				}
			}
			// Услуги/доставка → операционный расход (отдельный source_ref, чтобы
			// не конфликтовать с товарным по UNIQUE(restaurant_id, source_ref)).
			if decimal.IsPositive(servicePaid) {
				svcCat := "Услуги/доставка"
				svcSrc := "receipt_service:" + receiptID
				svcDesc := "Услуги/доставка по накладной"
				if in.SupplierName != nil && *in.SupplierName != "" {
					svcDesc = "Услуги/доставка — " + *in.SupplierName
				}
				svcOp := &models.FinancialOperation{
					ID:           uuid.NewString(),
					Type:         &opType,
					Amount:       servicePaid,
					Category:     &svcCat,
					AccountID:    &accID,
					AccountName:  acc.Name,
					Activity:     &opActivity,
					Date:         &opDate,
					Description:  &svcDesc,
					Counterparty: in.SupplierName,
					IsAuto:       &isAuto,
					SourceRef:    &svcSrc,
					RestaurantID: &ridStr,
					CreatedBy:    actorIDPtr(ctx),
					CreatedAt:    now,
					UpdatedAt:    now,
				}
				if err := tx.Create(svcOp).Error; err != nil {
					return err
				}
			}
		}

		// Неоплаченная часть → долг поставщику (авто-обязательство: баланс читает
		// Σ suppliers.current_debt). Раньше долг нигде не начислялся, из-за чего
		// кредитные/частичные приёмки занижали пассивы и завышали капитал на
		// сумму долга. Начисляем только при известном поставщике.
		if in.SupplierID != nil && *in.SupplierID != "" && decimal.IsPositive(debt) {
			var sup models.Supplier
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, *in.SupplierID).First(&sup).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "supplier not found", err)
			}
			sup.CurrentDebt = decimal.Normalize(decimal.Add(sup.CurrentDebt, debt))
			if err := tx.Model(&sup).Updates(map[string]any{"current_debt": sup.CurrentDebt, "updated_at": now}).Error; err != nil {
				return err
			}
			if err := recordSupplierSync(tx, []string{sup.ID}); err != nil {
				return err
			}
		}

		if err := recordReceiptSync(tx, []string{receiptID}); err != nil {
			return err
		}

		created = receipt
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventStockMovement, map[string]any{
			"kind":         "receipt",
			"receipt_id":   created.ID,
			"lines":        len(in.Lines),
			"total_amount": totalAmount.String(),
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return created, nil
}

// ReceiptUpdateInput — body PATCH /api/v1/stock/receipts/{id}. Все поля —
// указатели: не заданное не меняется (PATCH-семантика).
type ReceiptUpdateInput struct {
	SupplierID   *string             `json:"supplier_id,omitempty"`
	SupplierName *string             `json:"supplier_name,omitempty"`
	Date         *string             `json:"date,omitempty"`
	Note         *string             `json:"note,omitempty"`
	DueDate      *string             `json:"due_date,omitempty"`
	PaymentType  *string             `json:"payment_type,omitempty"`
	PaidAmount   *string             `json:"paid_amount,omitempty"`
	AccountID    *string             `json:"account_id,omitempty"`
	Lines        []ReceiptLineUpdate `json:"lines,omitempty"`
}

// ReceiptLineUpdate — правка ОДНОЙ уже существующей строки накладной.
// IngredientID неизменяем — перекатегоризация товар↔услуга не входит в
// UpdateReceipt (обнулить строку qty=0 + завести верную позицию отдельной
// накладной через CreateReceipt). Новые строки через Update не добавляются.
type ReceiptLineUpdate struct {
	LineID       string  `json:"line_id"`
	Qty          *string `json:"qty,omitempty"`
	PricePerUnit *string `json:"price_per_unit,omitempty"`
}

func nilIfEmpty(s string) *string {
	if s == "" {
		return nil
	}
	return &s
}

// UpdateReceipt — правка уже созданной накладной ВЛАДЕЛЬЦЕМ (requireOwner —
// тот же класс риска, что requireOwner в finance.go Update: переписывание
// зафиксированной истории денег/склада, явная просьба владельца, не
// inventory.manage — иначе кладовщик мог бы задним числом менять чужие
// приёмки).
//
// Тиры (детали — см. план и комментарии по ходу функции):
//
//	A — note/due_date: без каскада.
//	B — date (каскадом правит date у связанных financial_operations, иначе
//	    расход «переедет» в другой отчётный период молча, foBizDay читает
//	    именно это поле) и supplier (только пока debt_amount=0 — перенос
//	    долга между поставщиками не входит в v1).
//	C — payment_type/paid_amount/account_id: payment_type — источник истины,
//	    paid_amount выводится из него ('paid' = total, 'credit' = 0) и как
//	    свободное целевое АБСОЛЮТНОЕ значение (не дельта) принимается только
//	    у 'partial'. Дельта применяется к балансу счёта и
//	    supplier.CurrentDebt; goods/service-сплит пересчитывается по формуле
//	    CreateReceipt. account_id в апдейте обязан совпадать с уже связанным
//	    (смена счёта оплаты задним числом отложена).
//	D — строки (qty/price_per_unit): см. комментарий перед циклом ниже.
//
// Проводки-источники (stock_purchase/receipt_service) МУТИРУЮТСЯ на месте, не
// cancel+recreate: uq_finops_tenant_receipt_source_ref — partial unique index
// (миграция 013, WHERE source_ref LIKE 'receipt:%') покрывает товарную
// проводку, но НЕ покрывает "receipt_service:"+id (подчёркивание рвёт LIKE-
// префикс) — вставить вторую строку с тем же source_ref физически нельзя.
func (s *StockService) UpdateReceipt(ctx context.Context, id string, in ReceiptUpdateInput) (*models.StockReceipt, error) {
	if err := requireOwner(ctx, s.r); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if id == "" {
		return nil, apperrors.Wrap("VALIDATION", "id is required", nil)
	}

	// Парсинг новых значений строк ДО транзакции — как в CreateReceipt.
	type lineEdit struct {
		lineID string
		qty    *decimal.Decimal
		ppu    *decimal.Decimal
	}
	edits := make([]lineEdit, 0, len(in.Lines))
	seenLine := map[string]bool{}
	for _, l := range in.Lines {
		if l.LineID == "" {
			return nil, apperrors.Wrap("VALIDATION", "line_id is required", nil)
		}
		if seenLine[l.LineID] {
			return nil, apperrors.Wrap("VALIDATION", "дублирующийся line_id: "+l.LineID, nil)
		}
		seenLine[l.LineID] = true
		le := lineEdit{lineID: l.LineID}
		if l.Qty != nil && *l.Qty != "" {
			q, perr := decimal.FromString(*l.Qty)
			if perr != nil || decimal.IsNegative(q) {
				return nil, apperrors.Wrap("VALIDATION", "bad qty in line", perr)
			}
			le.qty = &q
		}
		if l.PricePerUnit != nil && *l.PricePerUnit != "" {
			p, perr := decimal.FromString(*l.PricePerUnit)
			if perr != nil || decimal.IsNegative(p) {
				return nil, apperrors.Wrap("VALIDATION", "bad price_per_unit in line", perr)
			}
			le.ppu = &p
		}
		if le.qty == nil && le.ppu == nil {
			continue
		}
		edits = append(edits, le)
	}

	now := time.Now().UTC()
	var updated models.StockReceipt
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Пик поставщика (без замка) — узнать текущего, решить, меняется ли.
		var peek models.StockReceipt
		if err := tx.Select("id", "supplier_id").
			Where("restaurant_id = ? AND id = ?", rid, id).First(&peek).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		oldSupplierID := derefOr(peek.SupplierID, "")
		newSupplierID := derefOr(in.SupplierID, oldSupplierID)
		supplierChanging := in.SupplierID != nil && newSupplierID != oldSupplierID

		// Канонический порядок замков (см. CreateReceipt/CreateReturn): поставщик(и)
		// → накладная → счёт → ингредиенты. ID ASC — не поймать deadlock со
		// встречным Update на пересекающейся паре поставщиков.
		supplierIDs := []string{}
		seenSup := map[string]bool{}
		for _, sid := range []string{oldSupplierID, newSupplierID} {
			if sid != "" && !seenSup[sid] {
				seenSup[sid] = true
				supplierIDs = append(supplierIDs, sid)
			}
		}
		sort.Strings(supplierIDs)
		suppliers := map[string]*models.Supplier{}
		if len(supplierIDs) > 0 {
			var rows []models.Supplier
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id IN ?", rid, supplierIDs).
				Order("id ASC").Find(&rows).Error; err != nil {
				return err
			}
			for i := range rows {
				suppliers[rows[i].ID] = &rows[i]
			}
		}

		// Накладная под замком — читаем заново авторитетное состояние.
		var receipt models.StockReceipt
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, id).First(&receipt).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		// Начальный долг (067) — запись БЕЗ товарных строк: сумма живёт прямо в
		// total_amount, выводить её здесь не из чего. Тир C ниже считает total
		// суммой строк, то есть для такой записи вывел бы 0 и молча обнулил долг
		// вместе с current_debt поставщика. Правится отдельным путём —
		// SuppliersService.UpdateOpeningDebt (PATCH /suppliers/{id}/opening-debt/{id}).
		if receipt.IsOpeningDebt {
			return apperrors.Wrap("VALIDATION", "это начальный долг без накладной — правьте его в карточке поставщика", nil)
		}
		if supplierChanging && decimal.IsPositive(receipt.DebtAmount) {
			return apperrors.Wrap("VALIDATION", "нельзя сменить поставщика: по накладной есть непогашенный долг — сначала погасите или верните долг", nil)
		}
		// newDate — деловая дата ОБЕИХ связанных проводок (см. заголовок функции,
		// поправка 1 плана): не задано в апдейте → остаётся как было у накладной.
		newDate := derefOr(in.Date, derefOr(receipt.Date, now.Format("2006-01-02")))

		// Связанные проводки (пик без замка — под защитой замка накладной).
		var goodsOp, serviceOp *models.FinancialOperation
		{
			goodsRef, serviceRef := "receipt:"+id, "receipt_service:"+id
			var ops []models.FinancialOperation
			if err := tx.Where("restaurant_id = ? AND source_ref IN ?", rid, []string{goodsRef, serviceRef}).
				Find(&ops).Error; err != nil {
				return err
			}
			for i := range ops {
				switch derefOr(ops[i].SourceRef, "") {
				case goodsRef:
					goodsOp = &ops[i]
				case serviceRef:
					serviceOp = &ops[i]
				}
			}
		}
		existingAccountID := ""
		if goodsOp != nil {
			existingAccountID = derefOr(goodsOp.AccountID, "")
		} else if serviceOp != nil {
			existingAccountID = derefOr(serviceOp.AccountID, "")
		}
		targetAccountID := existingAccountID
		if in.AccountID != nil && *in.AccountID != "" {
			if existingAccountID != "" && *in.AccountID != existingAccountID {
				return apperrors.Wrap("VALIDATION", "нельзя сменить счёт оплаты через редактирование накладной", nil)
			}
			targetAccountID = *in.AccountID
		}

		// ── Строки — загрузка + лок затронутых ингредиентов ────────────────
		var lines []models.StockReceiptLine
		if err := tx.Where("receipt_id = ?", receipt.ID).Find(&lines).Error; err != nil {
			return err
		}
		lineByID := make(map[string]*models.StockReceiptLine, len(lines))
		for i := range lines {
			lineByID[lines[i].ID] = &lines[i]
		}
		for _, le := range edits {
			if lineByID[le.lineID] == nil {
				return apperrors.Wrap("VALIDATION", "строка не принадлежит этой накладной: "+le.lineID, nil)
			}
		}
		touchedIngIDs := []string{}
		seenIng := map[string]bool{}
		for _, le := range edits {
			l := lineByID[le.lineID]
			ingID := deref(l.IngredientID)
			if ingID == "" {
				continue
			}
			if !seenIng[ingID] {
				seenIng[ingID] = true
				touchedIngIDs = append(touchedIngIDs, ingID)
			}
		}
		ingByID := map[string]*models.Ingredient{}
		if len(touchedIngIDs) > 0 {
			var ings []models.Ingredient
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id IN ?", rid, touchedIngIDs).
				Order("id").Find(&ings).Error; err != nil {
				return err
			}
			for i := range ings {
				ingByID[ings[i].ID] = &ings[i]
			}
		}

		// Уже возвращённое по каждой затронутой строке (граница уменьшения qty,
		// та же формула, что availableToReturn/CreateReturn — переиспользовать
		// сам метод нельзя, он на StockReadsService, не в этой транзакции).
		alreadyReturned := map[string]decimal.Decimal{}
		if len(edits) > 0 {
			editLineIDs := make([]string, len(edits))
			for i, le := range edits {
				editLineIDs[i] = le.lineID
			}
			var rows []struct {
				ReceiptLineID string          `gorm:"column:receipt_line_id"`
				Qty           decimal.Decimal `gorm:"column:qty"`
			}
			if err := tx.Model(&models.StockReturnLine{}).
				Joins("JOIN stock_returns sr ON sr.id = stock_return_lines.return_id").
				Select("stock_return_lines.receipt_line_id AS receipt_line_id, COALESCE(SUM(stock_return_lines.qty), 0) AS qty").
				Where("stock_return_lines.receipt_line_id IN ?", editLineIDs).
				Where("sr.cancelled_at IS NULL").
				Group("stock_return_lines.receipt_line_id").Scan(&rows).Error; err != nil {
				return err
			}
			for _, r := range rows {
				alreadyReturned[r.ReceiptLineID] = r.Qty
			}
		}

		// consumedSince — был ли расход ингредиента ПОСЛЕ этой приёмки (та же
		// граница, что CreateReturn: см. миграцию-комментарий там). Исключаем
		// return_supplier (сторно приёмки — обратный ход, не потребление) И
		// receipt_correction (наши же прошлые правки этой функции — иначе
		// собственная более ранняя коррекция блокирует следующую).
		consumedSince := map[string]bool{}
		for ingID := range ingByID {
			var n int64
			if err := tx.Model(&models.StockMovement{}).
				Where("restaurant_id = ? AND ingredient_id = ? AND created_at > ?", rid, ingID, receipt.CreatedAt).
				Where("qty < 0 AND COALESCE(type, '') NOT IN ?", []string{"return_supplier", "receipt_correction"}).
				Count(&n).Error; err != nil {
				return err
			}
			consumedSince[ingID] = n > 0
		}

		// ── Тир D: построчная обработка ─────────────────────────────────────
		//
		// Единая формула для qty/цены/обоих сразу — реверс-и-заново на
		// средневзвешенной (аддитивна по партиям, см. CreateReturn): вычитаем
		// вклад СТАРОЙ версии строки, добавляем вклад НОВОЙ. Алгебраически точно,
		// пока baseQty (= текущий остаток минус исходный вклад строки) > 0.
		//
		// Когда baseQty <= 0 ("вычесть уже нечего откуда" — остаток меньше того,
		// что строка когда-то принесла: расход/возврат уже смешали её вклад со
		// всем прочим) — поведение РАСХОДИТСЯ для qty и явной правки цены, тем же
		// принципом, что уже применяет CreateReturn для точно такой же ситуации:
		//   - qty меняем ВСЕГДА (bounded отдельно — см. ниже), а
		//     ingredients.price_per_unit просто НЕ трогаем, если цену строки никто
		//     явно не менял (CreateReturn делает буквально так же: при
		//     consumedSince цена остаётся прежней, а не ошибка);
		//   - явную правку ЦЕНЫ в этом состоянии применяем, только если
		//     потребления не было (безопасный "единопартийный" фолбэк — та же
		//     формула, что CreateReceipt использует при ing.Qty<=0), иначе 409 —
		//     тихо проигнорировать явную просьбу владельца было бы хуже отказа.
		//
		// Отдельно, ВСЕГДА при любом уменьшении qty (независимо от baseQty):
		// граница "не ниже уже возвращённого поставщику" и "не больше остатка на
		// складе" — она про физическое наличие товара, а не про корректность
		// средневзвешенной, и потому не связана с consumedSince вообще.
		newTotalAmount := decimal.Zero
		newServiceTotal := decimal.Zero
		for i := range lines {
			l := lines[i]
			targetQty := l.Qty
			targetPPU := l.PricePerUnit
			var le *lineEdit
			for j := range edits {
				if edits[j].lineID == l.ID {
					le = &edits[j]
					break
				}
			}
			if le != nil {
				if le.qty != nil {
					targetQty = *le.qty
				}
				if le.ppu != nil {
					targetPPU = *le.ppu
				}
			}

			ingID := deref(l.IngredientID)
			if le != nil && ingID != "" {
				ing := ingByID[ingID]
				if ing == nil {
					return apperrors.Wrap("CONFLICT", "товар удалён со склада — изменить эту строку нельзя: "+deref(l.Name), nil)
				}
				stockUnit := derefOr(ing.Unit, "")
				oldStockQty := units.Convert(l.Qty, deref(l.Unit), stockUnit)
				newStockQty := units.Convert(targetQty, deref(l.Unit), stockUnit)
				delta := decimal.Sub(newStockQty, oldStockQty)

				if decimal.IsNegative(delta) {
					decreaseInLineUnit := decimal.Sub(l.Qty, targetQty)
					unreturned := decimal.Sub(l.Qty, alreadyReturned[l.ID])
					if decreaseInLineUnit.GreaterThan(unreturned) {
						return apperrors.Wrap("CONFLICT", "нельзя уменьшить количество ниже уже возвращённого поставщику ("+alreadyReturned[l.ID].String()+"): "+deref(l.Name), nil)
					}
					decreaseStock := delta.Neg()
					if decreaseStock.GreaterThan(ing.Qty) {
						return apperrors.Wrap("CONFLICT", "на складе недостаточно товара, чтобы уменьшить количество: остаток "+ing.Qty.String()+": "+deref(l.Name), nil)
					}
				}

				oldLineCost := decimal.Normalize(decimal.Mul(l.Qty, l.PricePerUnit))
				newLineCost := decimal.Normalize(decimal.Mul(targetQty, targetPPU))
				baseQty := decimal.Sub(ing.Qty, oldStockQty)
				baseValue := decimal.Sub(decimal.Mul(ing.Qty, ing.PricePerUnit), oldLineCost)
				newIngQty := decimal.Add(baseQty, newStockQty)

				if newStockQty.IsZero() {
					// Строка обнулена — блендить нечего, цену не трогаем.
					if decimal.IsNegative(newIngQty) {
						newIngQty = decimal.Zero
					}
				} else if !decimal.IsPositive(baseQty) {
					// baseQty<=0: "вычесть вклад строки уже неоткуда" — текущий остаток
					// меньше того, что эта строка когда-то принесла (расход/возврат уже
					// смешали её со всем прочим). Как и CreateReturn (тот же денормиатор):
					// если ЦЕНА не менялась явно — просто НЕ трогаем ingredients.price_per_unit
					// (qty всё равно меняем ниже, это не ошибка, а "нечего пересчитывать").
					// Явную же правку цены в этом состоянии честно можно применить только
					// если ничего не потреблялось — иначе отбиваем, а не тихо игнорируем
					// то, что владелец прямо попросил поменять.
					if le.ppu != nil {
						if consumedSince[ingID] {
							return apperrors.Wrap("CONFLICT", "нельзя изменить цену строки — товар уже расходовался после этой приёмки: "+deref(l.Name), nil)
						}
						newPrice := decimal.Normalize(decimal.DivRound(newLineCost, newStockQty))
						ing.PricePerUnit = newPrice
						if err := tx.Model(&models.Ingredient{}).
							Where("restaurant_id = ? AND id = ?", rid, ingID).
							Update("price_per_unit", newPrice).Error; err != nil {
							return err
						}
					}
				} else {
					newPrice := decimal.Normalize(decimal.DivRound(decimal.Add(baseValue, newLineCost), newIngQty))
					ing.PricePerUnit = newPrice
					if err := tx.Model(&models.Ingredient{}).
						Where("restaurant_id = ? AND id = ?", rid, ingID).
						Update("price_per_unit", newPrice).Error; err != nil {
						return err
					}
				}
				ing.Qty = newIngQty

				if !delta.IsZero() {
					mvType := "receipt_correction"
					desc := "receipt:" + id
					mv := &models.StockMovement{
						ID: uuid.NewString(), Type: &mvType, IngredientID: &ingID, IngredientName: l.Name,
						Description: &desc, Qty: delta, Unit: &stockUnit, RestaurantID: &rid, CreatedAt: now,
					}
					if err := tx.Create(mv).Error; err != nil {
						return err
					}
				}

				if err := tx.Model(&models.StockReceiptLine{}).Where("id = ?", l.ID).
					Updates(map[string]any{"qty": targetQty, "price_per_unit": targetPPU, "updated_at": now}).Error; err != nil {
					return err
				}
			} else if le != nil {
				// Сервисная строка (без ингредиента) — просто числа, без склада.
				if err := tx.Model(&models.StockReceiptLine{}).Where("id = ?", l.ID).
					Updates(map[string]any{"qty": targetQty, "price_per_unit": targetPPU, "updated_at": now}).Error; err != nil {
					return err
				}
			}

			lineTotal := decimal.Normalize(decimal.Mul(targetQty, targetPPU))
			newTotalAmount = decimal.Add(newTotalAmount, lineTotal)
			if ingID == "" {
				newServiceTotal = decimal.Add(newServiceTotal, lineTotal)
			}
		}
		newTotalAmount = decimal.Normalize(newTotalAmount)
		newServiceTotal = decimal.Normalize(newServiceTotal)

		// ── Тир C: оплата ────────────────────────────────────────────────
		newPaymentType := derefOr(in.PaymentType, derefOr(receipt.PaymentType, "paid"))
		var newPaidAmount decimal.Decimal
		switch {
		case newPaymentType == "paid":
			newPaidAmount = newTotalAmount
		case newPaymentType == "credit":
			// Симметрично "paid": тип оплаты — источник истины, paid_amount из него
			// ВЫВОДИТСЯ, а не принимается от клиента. "Кредит" по определению значит
			// «не платили»: paid=0, весь total уходит в долг поставщику.
			//
			// Без этой ветки бэк доверял присланному paid_amount, а диалог правки
			// (edit-receipt-dialog) префиллил поле текущей оплатой и не сбрасывал его
			// при переключении на «Кредит» — оплаченная накладная переводилась в
			// кредит с paid_amount=total: accountDelta=0 (деньги не вернулись),
			// newDebt=0 (долг поставщику не вырос), а в заголовке оседало
			// противоречие payment_type="credit" + paid_amount=total + debt_amount=0.
			// Инвариант документирован в CreateReceipt (см. комментарий про
			// «'paid' = total, 'partial' = paid_amount, 'credit' = 0»), но
			// соблюдался только при создании.
			//
			// Форсируем безусловно, а не только при явном in.PaymentType: иначе
			// уже испорченные строки чинились бы лишь при повторном выборе типа.
			// Как следствие, первая же правка такой накладной доводит её до
			// консистентного вида — вернёт деньги на счёт и начислит долг (а если
			// поставщик не проставлен, отобьёт понятной ошибкой ниже).
			newPaidAmount = decimal.Zero
		case in.PaidAmount != nil:
			p, perr := decimal.FromString(*in.PaidAmount)
			if perr != nil || decimal.IsNegative(p) {
				return apperrors.Wrap("VALIDATION", "bad paid_amount", perr)
			}
			newPaidAmount = p
		default:
			newPaidAmount = receipt.PaidAmount
		}
		// "paid"/"credit" всегда форсируют newPaidAmount (ветки выше) — при
		// уменьшении total через правку строк это КОРРЕКТНО и намеренно тянет за
		// собой возврат разницы на счёт (accountDelta ниже, может уйти в обе
		// стороны — см. комментарий Тира C в шапке функции): "оплачено" по
		// определению равно total/нулю для этих типов, отдельного подтверждения не
		// требует. Свободный paid_amount остаётся только у "partial" — и там
		// защищаем инвариант: оплачено не может ПРЕВЫШАТЬ сумму накладной.
		if newPaidAmount.GreaterThan(newTotalAmount) {
			return apperrors.Wrap("VALIDATION", "оплачено не может быть больше суммы накладной", nil)
		}
		newDebt := decimal.Normalize(decimal.Sub(newTotalAmount, newPaidAmount))
		if decimal.IsPositive(newDebt) && newSupplierID == "" {
			return apperrors.Wrap("VALIDATION", "накладная в долг требует поставщика: долг не на кого записать", nil)
		}

		accountDelta := decimal.Sub(newPaidAmount, receipt.PaidAmount)
		var acc *models.FinancialAccount
		if !accountDelta.IsZero() {
			if targetAccountID == "" {
				return apperrors.Wrap("VALIDATION", "account_id is required", nil)
			}
			var a models.FinancialAccount
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, targetAccountID).First(&a).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "account not found", err)
			}
			if !a.IsEnabled {
				return apperrors.Wrap("CONFLICT", "счёт отключён — выберите другой счёт", nil)
			}
			newBal := decimal.Normalize(decimal.Sub(a.Balance, accountDelta))
			if decimal.IsNegative(newBal) {
				return apperrors.Wrap("CONFLICT", "insufficient funds on account", nil)
			}
			a.Balance = newBal
			acc = &a
			if err := tx.Model(acc).Updates(map[string]any{"balance": acc.Balance, "updated_at": now}).Error; err != nil {
				return err
			}
		}

		// Товарный/сервисный сплит — та же формула, что CreateReceipt. Считаем
		// ДАЖЕ если accountDelta==0: правка строк могла сдвинуть serviceTotal/
		// totalAmount, а значит и сплит уже неизменного paid_amount.
		servicePaid := decimal.Zero
		if decimal.IsPositive(newServiceTotal) && decimal.IsPositive(newTotalAmount) {
			servicePaid = decimal.Normalize(decimal.DivRound(decimal.Mul(newPaidAmount, newServiceTotal), newTotalAmount))
			if servicePaid.GreaterThan(newPaidAmount) {
				servicePaid = newPaidAmount
			}
		}
		goodsPaid := decimal.Normalize(decimal.Sub(newPaidAmount, servicePaid))

		desc := "Приёмка"
		if newSupplierName := derefOr(in.SupplierName, derefOr(receipt.SupplierName, "")); newSupplierName != "" {
			desc = "Приёмка от " + newSupplierName
		}
		accName := (*string)(nil)
		if acc != nil {
			accName = acc.Name
		} else if targetAccountID != "" {
			// Баланс не тронут (accountDelta==0), но проводке всё равно нужно
			// имя счёта для отображения — подтягиваем без замка, писать не будем.
			var a models.FinancialAccount
			if err := tx.Select("id", "name").Where("restaurant_id = ? AND id = ?", rid, targetAccountID).First(&a).Error; err == nil {
				accName = a.Name
			}
		}
		upsertLinkedOp := func(existing *models.FinancialOperation, amount decimal.Decimal, category, sourceRef string) error {
			hasContent := decimal.IsPositive(amount) || (category == "stock_purchase" && newServiceTotal.IsZero())
			if existing == nil {
				if !hasContent || targetAccountID == "" {
					return nil
				}
				outType, activity, isAuto := "out", "operational", true
				op := &models.FinancialOperation{
					ID: uuid.NewString(), Type: &outType, Amount: amount, Category: &category,
					AccountID: &targetAccountID, AccountName: accName, Activity: &activity,
					Date: &newDate, Description: &desc, IsAuto: &isAuto, SourceRef: &sourceRef,
					RestaurantID: &rid, CreatedBy: actorIDPtr(ctx), CreatedAt: now, UpdatedAt: now,
				}
				return tx.Create(op).Error
			}
			return tx.Model(existing).Updates(map[string]any{
				"amount": amount, "account_id": targetAccountID, "account_name": accName,
				"date": newDate, "description": desc, "updated_at": now,
			}).Error
		}
		if err := upsertLinkedOp(goodsOp, goodsPaid, "stock_purchase", "receipt:"+id); err != nil {
			return err
		}
		if err := upsertLinkedOp(serviceOp, servicePaid, "Услуги/доставка", "receipt_service:"+id); err != nil {
			return err
		}
		// ── Долг поставщика(ов) ──────────────────────────────────────────
		if oldSupplierID != "" {
			if sup, ok := suppliers[oldSupplierID]; ok {
				sup.CurrentDebt = decimal.Normalize(decimal.Sub(sup.CurrentDebt, receipt.DebtAmount))
				if err := tx.Model(sup).Updates(map[string]any{"current_debt": sup.CurrentDebt, "updated_at": now}).Error; err != nil {
					return err
				}
			}
		}
		if newSupplierID != "" && decimal.IsPositive(newDebt) {
			// Тот же поставщик, что и oldSupplierID, — его current_debt уже
			// скорректирован строкой выше (вычли старый долг накладной); здесь
			// просто добавляем новый поверх, оба шага складываются в чистую дельту.
			if sup, ok := suppliers[newSupplierID]; ok {
				sup.CurrentDebt = decimal.Normalize(decimal.Add(sup.CurrentDebt, newDebt))
				if err := tx.Model(sup).Updates(map[string]any{"current_debt": sup.CurrentDebt, "updated_at": now}).Error; err != nil {
					return err
				}
			}
		}

		// ── Заголовок накладной ──────────────────────────────────────────
		headerUpdates := map[string]any{
			"updated_at": now, "total_amount": newTotalAmount, "payment_type": newPaymentType,
			"paid_amount": newPaidAmount, "debt_amount": newDebt,
		}
		if in.Date != nil && *in.Date != "" {
			headerUpdates["date"] = newDate
		}
		if in.Note != nil {
			headerUpdates["note"] = *in.Note
		}
		if in.DueDate != nil {
			headerUpdates["due_date"] = *in.DueDate
		}
		if supplierChanging {
			headerUpdates["supplier_id"] = nilIfEmpty(newSupplierID)
			headerUpdates["supplier_name"] = derefOr(in.SupplierName, derefOr(receipt.SupplierName, ""))
		} else if in.SupplierName != nil {
			headerUpdates["supplier_name"] = *in.SupplierName
		}
		if err := tx.Model(&models.StockReceipt{}).Where("id = ?", receipt.ID).
			Updates(headerUpdates).Error; err != nil {
			return err
		}

		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&updated).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventStockMovement, map[string]any{"kind": "receipt_update", "receipt_id": updated.ID})
		s.pub.Flush(ctx, rid, buf)
	}
	return &updated, nil
}

// CreateWriteoff списывает товар. Создаёт stock_writeoffs + lines +
// stock_movements (qty < 0).
func (s *StockService) CreateWriteoff(ctx context.Context, in WriteoffInput) (*models.StockWriteoff, error) {
	if err := requirePermFor(ctx, s.r, "writeoffs.create"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Reason == "" {
		return nil, apperrors.Wrap("VALIDATION", "reason required", nil)
	}
	if len(in.Lines) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "at least one line required", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()

	// Н5: клиентский cost больше не участвует в деньгах — стоимость каждой
	// строки считает сервер по цене сущности. Парсим только qty.
	parsed := make([]struct {
		in  WriteoffLine
		qty decimal.Decimal
	}, len(in.Lines))
	for i, l := range in.Lines {
		qty, err := decimal.FromString(l.Qty)
		if err != nil || !decimal.IsPositive(qty) {
			return nil, apperrors.Wrap("VALIDATION", "bad qty in line", err)
		}
		parsed[i] = struct {
			in  WriteoffLine
			qty decimal.Decimal
		}{l, qty}
	}

	var created *models.StockWriteoff
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		writeoffID := uuid.NewString()
		creator := actor.UserID
		reason := in.Reason
		w := &models.StockWriteoff{
			ID:           writeoffID,
			Reason:       &reason,
			Description:  in.Description,
			TotalCost:    decimal.Zero, // пересчитается сервером после цикла (Н5)
			CreatedBy:    &creator,
			RestaurantID: &rid,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(w).Error; err != nil {
			return err
		}
		// #21: для semi/batch фактически снятое может быть МЕНЬШЕ запрошенного
		// (остаток кончился) → пишем фактически снятое.
		// Н5/Н6: стоимость и складское количество считает СЕРВЕР. Клиентский
		// pl.cost игнорируется (как price-override позиции в заказе — политика
		// v3.16.7), а qty ингредиента конвертируется в единицу склада ДО
		// движения. Раньше движение писалось в единице строки: «500 г» при
		// складе в кг денормализовало остаток как −500 кг. Стоимость строки =
		// складское_кол-во × цена (ингредиент), qty × цена п/ф (semi), qty ×
		// себестоимость порции (batch) — единый источник цены, а не клиент.
		actualTotal := decimal.Zero
		for _, pl := range parsed {
			actualQty := pl.qty  // в единице документа (для строки-записи)
			stockQty := pl.qty   // в единице склада (для движения/стоимости)
			mvUnit := pl.in.Unit // единица движения — склада
			var actualCost decimal.Decimal
			switch pl.in.Kind {
			case "semi":
				var stock models.SemiFinishedStock
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
					Where("restaurant_id = ? AND id = ?", rid, pl.in.IngredientID).First(&stock).Error; err != nil {
					if errors.Is(err, gorm.ErrRecordNotFound) {
						return apperrors.Wrap("VALIDATION", "semi stock not found: "+pl.in.IngredientID, nil)
					}
					return err
				}
				if actualQty.GreaterThan(stock.Qty) {
					actualQty = stock.Qty
					if decimal.IsNegative(actualQty) {
						actualQty = decimal.Zero
					}
				}
				stockQty = actualQty
				actualCost = decimal.Normalize(decimal.Mul(actualQty, stock.PricePerUnit))
			case "batch":
				var mi models.MenuItem
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
					Where("restaurant_id = ? AND id = ?", rid, pl.in.IngredientID).First(&mi).Error; err != nil {
					if errors.Is(err, gorm.ErrRecordNotFound) {
						return apperrors.Wrap("VALIDATION", "batch menu item not found: "+pl.in.IngredientID, nil)
					}
					return err
				}
				prepared := decimal.Zero
				if mi.PreparedQty != nil {
					prepared = decimal.FromInt(int64(*mi.PreparedQty))
				}
				if actualQty.GreaterThan(prepared) {
					actualQty = prepared
				}
				stockQty = actualQty
				actualCost = decimal.Normalize(decimal.Mul(actualQty, mi.COGS))
			default:
				// Ингредиент: грузим под замком (нужны единица склада + цена).
				// Раньше здесь ингредиент вообще не загружался — движение с чужим
				// id тихо денормализовало 0 строк, а стоимость бралась с клиента.
				var ing models.Ingredient
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
					Where("restaurant_id = ? AND id = ?", rid, pl.in.IngredientID).First(&ing).Error; err != nil {
					if errors.Is(err, gorm.ErrRecordNotFound) {
						return apperrors.Wrap("VALIDATION", "ingredient not found: "+pl.in.IngredientID, nil)
					}
					return err
				}
				stockUnit := deref(ing.Unit)
				// Конвертация в единицу склада — симметрично приёмке
				// (см. CreateReceipt). Несводимые пары Convert возвращает как есть
				// (штучный склад/строка в шт → без изменений).
				stockQty = units.Convert(pl.qty, deref(pl.in.Unit), stockUnit)
				if stockUnit != "" {
					mvUnit = &stockUnit
				}
				actualCost = decimal.Normalize(decimal.Mul(stockQty, ing.PricePerUnit))
			}
			actualTotal = decimal.Add(actualTotal, actualCost)

			lineID := uuid.NewString()
			wl := &models.StockWriteoffLine{
				ID:           lineID,
				WriteoffID:   &writeoffID,
				IngredientID: &pl.in.IngredientID,
				Name:         &pl.in.Name,
				Qty:          decimal.Normalize(actualQty),
				Unit:         pl.in.Unit,
				Cost:         actualCost,
				UpdatedAt:    now,
			}
			if err := tx.Create(wl).Error; err != nil {
				return err
			}
			switch pl.in.Kind {
			case "semi":
				if err := tx.Model(&models.SemiFinishedStock{}).
					Where("restaurant_id = ? AND id = ?", rid, pl.in.IngredientID).
					Updates(map[string]any{"qty": gorm.Expr("qty - ?", actualQty), "updated_at": now}).Error; err != nil {
					return err
				}
			case "batch":
				if err := tx.Model(&models.MenuItem{}).
					Where("restaurant_id = ? AND id = ?", rid, pl.in.IngredientID).
					Updates(map[string]any{"prepared_qty": gorm.Expr("prepared_qty - ?", int(actualQty.IntPart())), "updated_at": now}).Error; err != nil {
					return err
				}
			default:
				// Ингредиент: stock_movement type='writeoff' в единице склада →
				// хук денормализует ingredients.qty (единственный корректный путь).
				mvType := "writeoff"
				desc := "writeoff:" + writeoffID
				mv := &models.StockMovement{
					ID:             uuid.NewString(),
					Type:           &mvType,
					IngredientID:   &pl.in.IngredientID,
					IngredientName: &pl.in.Name,
					Description:    &desc,
					Qty:            stockQty.Neg(),
					Unit:           mvUnit,
					RestaurantID:   &rid,
					CreatedAt:      now,
				}
				if err := tx.Create(mv).Error; err != nil {
					return err
				}
			}
		}
		// Header total — всегда пересчитанный сервером (клиентский totalCost
		// больше не источник истины для денег).
		if !actualTotal.Equal(w.TotalCost) {
			if err := tx.Model(w).Update("total_cost", decimal.Normalize(actualTotal)).Error; err != nil {
				return err
			}
			w.TotalCost = decimal.Normalize(actualTotal)
		}
		if err := recordWriteoffSync(tx, []string{writeoffID}); err != nil {
			return err
		}
		created = w
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventStockMovement, map[string]any{
			"kind":        "writeoff",
			"writeoff_id": created.ID,
			"lines":       len(in.Lines),
			"total_cost":  created.TotalCost.String(),
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return created, nil
}
