package service

import (
	"context"
	"errors"
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
