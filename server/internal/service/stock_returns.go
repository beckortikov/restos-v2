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
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/pkg/units"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ReturnInput — body POST /api/v1/stock/returns.
//
// Возврат поставщику испорченного/битого товара. Зеркало CreateReceipt:
// склад −qty, средневзвешенная себестоимость откатывается, деньги/долг
// возвращаются. Не путать со списанием (CreateWriteoff): списание — наш убыток
// и бьёт по прибыли, возврат — сторно закупки и прибыль не трогает.
type ReturnInput struct {
	ReceiptID string  `json:"receipt_id"`
	Date      string  `json:"date,omitempty"` // YYYY-MM-DD, default — today
	Reason    string  `json:"reason"`         // spoilage | breakage | expired | other
	Note      *string `json:"note,omitempty"`
	// RefundType — куда возвращаются деньги:
	//   debt  — накладная в долг: уменьшаем долг (AccountID не нужен);
	//   money — накладная оплачена: деньги приходят на AccountID.
	RefundType string       `json:"refund_type"`
	AccountID  *string      `json:"account_id,omitempty"`
	Lines      []ReturnLine `json:"lines"`
}

// ReturnLine — строка возврата: ссылка на строку накладной + количество.
//
// Цену/название/единицу клиент НЕ передаёт — берём из строки накладной. Причины:
// поставщик отдаёт ровно ту сумму, что взял (а не текущую средневзвешенную с/с
// склада), одна номенклатура может быть в накладной дважды по разным ценам, и
// клиентский price-override в принципе не доверяем (та же политика, что у позиций
// заказа: цена всегда с сервера, вручную только количество).
type ReturnLine struct {
	ReceiptLineID string `json:"receipt_line_id"`
	Qty           string `json:"qty"`
}

var returnReasons = map[string]struct{}{
	"spoilage": {}, "breakage": {}, "expired": {}, "other": {},
}

// CreateReturn оформляет возврат поставщику. В одной транзакции:
//   - stock_returns (header) + stock_return_lines (детали);
//   - stock_movements type="return_supplier" с отрицательным qty — склад
//     уменьшается только через event-stream, прямой UPDATE ingredients.qty запрещён;
//   - откат средневзвешенной себестоимости;
//   - деньги: уменьшение долга ЛИБО возврат на счёт + financial_operation.
func (s *StockService) CreateReturn(ctx context.Context, in ReturnInput) (*models.StockReturn, error) {
	if err := requirePermFor(ctx, s.r, "inventory.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.ReceiptID == "" {
		return nil, apperrors.Wrap("VALIDATION", "receipt_id required", nil)
	}
	if len(in.Lines) == 0 {
		return nil, apperrors.Wrap("VALIDATION", "at least one line required", nil)
	}
	if in.Reason == "" {
		in.Reason = "spoilage"
	}
	if _, ok := returnReasons[in.Reason]; !ok {
		return nil, apperrors.Wrap("VALIDATION", "bad reason", nil)
	}
	if in.RefundType == "" {
		in.RefundType = "debt"
	}
	if in.RefundType != "debt" && in.RefundType != "money" {
		return nil, apperrors.Wrap("VALIDATION", "bad refund_type", nil)
	}
	if in.RefundType == "money" && (in.AccountID == nil || *in.AccountID == "") {
		return nil, apperrors.Wrap("VALIDATION", "account_id required for refund_type=money", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()
	date := in.Date
	if date == "" {
		date = now.Format("2006-01-02")
	}

	var created *models.StockReturn
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Порядок замков — канонический (см. orders_perms.go): поставщик, затем
		// накладная. Поставщика надо узнать из накладной, поэтому сначала читаем
		// её БЕЗ замка — только ради supplier_id, — а под замком перечитываем.
		var peek models.StockReceipt
		if err := tx.Select("id", "supplier_id").
			Where("restaurant_id = ? AND id = ?", rid, in.ReceiptID).First(&peek).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		// Долг поставщика решает обе денежные ветки (см. ниже), а замок на нём
		// обязан быть взят первым.
		var sup *models.Supplier
		if peek.SupplierID != nil && *peek.SupplierID != "" {
			var s models.Supplier
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, *peek.SupplierID).First(&s).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "supplier not found", err)
			}
			sup = &s
		}

		// Накладная под замком: два параллельных возврата по одной накладной не
		// должны оба проскочить guard «Σ ≤ пришло» и не должны потерять одно из
		// уменьшений долга (read-modify-write debt_amount).
		var receipt models.StockReceipt
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, in.ReceiptID).First(&receipt).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}

		// Счёт — под замком и ДО ингредиентов (канонический порядок замков,
		// см. orders_perms.go). Списываем ниже, но приёмка берёт счёт раньше
		// ингредиентов, и обратный порядок здесь дал бы с ней AB-BA: приёмка
		// держит счёт и тянется к товару, возврат держит товар и тянется к счёту.
		var acc *models.FinancialAccount
		if in.RefundType == "money" {
			var a models.FinancialAccount
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, *in.AccountID).First(&a).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "account not found", err)
			}
			acc = &a
		}

		// Строки накладной — источник цены/названия/единицы.
		var rLines []models.StockReceiptLine
		if err := tx.Where("receipt_id = ?", receipt.ID).Find(&rLines).Error; err != nil {
			return err
		}
		lineByID := make(map[string]*models.StockReceiptLine, len(rLines))
		ids := make([]string, 0, len(rLines))
		for i := range rLines {
			lineByID[rLines[i].ID] = &rLines[i]
			ids = append(ids, rLines[i].ID)
		}

		// Уже возвращённое по каждой строке — база guard'а. stock_return_lines не
		// имеет restaurant_id; receipt_line_id IN ids (строки уже отскоупленной
		// накладной) — единственный безопасный фильтр, как в ListReceiptsWithLines.
		//
		// Отменённые возвраты не считаем: товар по ним приехал назад на склад,
		// значит его снова можно вернуть. Иначе ошибочный возврат навсегда
		// «съедал» количество, и после сторно вернуть товар было бы нечем.
		returned := make(map[string]decimal.Decimal, len(rLines))
		if len(ids) > 0 {
			var rows []struct {
				ReceiptLineID string          `gorm:"column:receipt_line_id"`
				Qty           decimal.Decimal `gorm:"column:qty"`
			}
			if err := tx.Model(&models.StockReturnLine{}).
				Joins("JOIN stock_returns sr ON sr.id = stock_return_lines.return_id").
				Select("stock_return_lines.receipt_line_id AS receipt_line_id, COALESCE(SUM(stock_return_lines.qty), 0) AS qty").
				Where("stock_return_lines.receipt_line_id IN ?", ids).
				Where("sr.cancelled_at IS NULL").
				Group("stock_return_lines.receipt_line_id").Scan(&rows).Error; err != nil {
				return err
			}
			for _, row := range rows {
				returned[row.ReceiptLineID] = row.Qty
			}
		}

		type parsedReturnLine struct {
			rl   *models.StockReceiptLine
			qty  decimal.Decimal
			cost decimal.Decimal
		}
		parsedLines := make([]parsedReturnLine, 0, len(in.Lines))
		totalAmount := decimal.Zero
		// Одна и та же строка накладной может прийти в теле дважды — guard обязан
		// смотреть на сумму запрошенного, иначе 2×3кг проскочат при остатке 5кг.
		wanted := make(map[string]decimal.Decimal, len(in.Lines))
		for _, l := range in.Lines {
			rl := lineByID[l.ReceiptLineID]
			if rl == nil {
				return apperrors.Wrap("VALIDATION", "receipt_line_id not in this receipt: "+l.ReceiptLineID, nil)
			}
			qty, err := decimal.FromString(l.Qty)
			if err != nil || !decimal.IsPositive(qty) {
				return apperrors.Wrap("VALIDATION", "bad qty in line", err)
			}
			acc := qty
			if prev, ok := wanted[rl.ID]; ok {
				acc = decimal.Add(prev, qty)
			}
			wanted[rl.ID] = acc
			if decimal.Add(returned[rl.ID], acc).GreaterThan(rl.Qty) {
				return apperrors.Wrap("CONFLICT", "нельзя вернуть больше, чем пришло по накладной: "+deref(rl.Name), nil)
			}
			cost := decimal.Normalize(decimal.Mul(qty, rl.PricePerUnit))
			parsedLines = append(parsedLines, parsedReturnLine{rl: rl, qty: qty, cost: cost})
			totalAmount = decimal.Add(totalAmount, cost)
		}
		totalAmount = decimal.Normalize(totalAmount)

		returnID := uuid.NewString()
		createdBy := actor.UserID
		ret := &models.StockReturn{
			ID:           returnID,
			ReceiptID:    receipt.ID,
			SupplierID:   receipt.SupplierID,
			SupplierName: receipt.SupplierName,
			Date:         &date,
			Reason:       in.Reason,
			Note:         in.Note,
			TotalAmount:  totalAmount,
			RefundType:   in.RefundType,
			AccountID:    in.AccountID,
			CreatedBy:    &createdBy,
			RestaurantID: &rid,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(ret).Error; err != nil {
			return err
		}

		// Ингредиенты позиций под замком: нужны единица склада + текущие qty/price
		// для конвертации и отката средневзвешенной. Lock защищает read-modify-write
		// цены от гонки с параллельной приёмкой того же ингредиента.
		ingByID := make(map[string]*models.Ingredient)
		{
			ingIDs := make([]string, 0, len(parsedLines))
			seen := make(map[string]struct{})
			for _, pl := range parsedLines {
				id := deref(pl.rl.IngredientID)
				if id == "" {
					continue
				}
				if _, ok := seen[id]; !ok {
					seen[id] = struct{}{}
					ingIDs = append(ingIDs, id)
				}
			}
			if len(ingIDs) > 0 {
				var ings []models.Ingredient
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
					Where("restaurant_id = ? AND id IN ?", rid, ingIDs).
					Order("id").Find(&ings).Error; err != nil {
					return err
				}
				for i := range ings {
					ingByID[ings[i].ID] = &ings[i]
				}
			}
		}

		// Был ли расход ингредиента ПОСЛЕ этой приёмки — решает, можно ли
		// откатывать средневзвешенную себестоимость (см. ниже, где считается цена).
		//
		// return_supplier исключаем намеренно: возврат — точный обратный ход
		// приёмки, после него состояние такое, будто приняли меньше. Поэтому
		// второй возврат по той же накладной откатывается так же точно, как первый.
		// Приходы тоже не мешают: стоимость аддитивна по партиям.
		consumedSince := make(map[string]bool, len(ingByID))
		for ingID := range ingByID {
			var n int64
			if err := tx.Model(&models.StockMovement{}).
				Where("restaurant_id = ? AND ingredient_id = ? AND created_at > ?", rid, ingID, receipt.CreatedAt).
				Where("qty < 0 AND COALESCE(type, '') <> ?", "return_supplier").
				Count(&n).Error; err != nil {
				return err
			}
			consumedSince[ingID] = n > 0
		}

		for _, pl := range parsedLines {
			line := &models.StockReturnLine{
				ID:            uuid.NewString(),
				ReturnID:      returnID,
				ReceiptLineID: pl.rl.ID,
				IngredientID:  pl.rl.IngredientID,
				Name:          pl.rl.Name,
				Qty:           pl.qty,
				Unit:          pl.rl.Unit,
				PricePerUnit:  pl.rl.PricePerUnit,
				CreatedAt:     now,
				UpdatedAt:     now,
			}
			ingID := deref(pl.rl.IngredientID)
			if ingID == "" {
				// Ингредиента нет — двигать нечего, но строку сохраняем.
				if err := tx.Create(line).Error; err != nil {
					return err
				}
				continue
			}
			ing := ingByID[ingID]

			// Конвертация в единицу склада — зеркало приёмки: приход 20000 г при
			// складе в кг лёг движением +20, возврат 3000 г обязан лечь −3.
			// Иначе ingredients.qty уедет на три порядка.
			stockUnit := ""
			if ing != nil && ing.Unit != nil {
				stockUnit = *ing.Unit
			}
			stockQty := units.Convert(pl.qty, deref(pl.rl.Unit), stockUnit)
			mvUnit := pl.rl.Unit
			if stockUnit != "" {
				mvUnit = &stockUnit
			}

			// Нельзя вернуть то, чего физически нет: товар уезжает поставщику.
			// Guard «Σ ≤ принятому» этого не ловит — приняли 20, съели 18,
			// осталось 2, а вернуть «по накладной» разрешал все 20 и выдавал за
			// них деньги. Списание в минус уходить может (там расход мог быть не
			// проведён), но возврат — это физическое перемещение, его не подделать.
			if ing != nil && stockQty.GreaterThan(ing.Qty) {
				return apperrors.Wrap("CONFLICT",
					"на складе недостаточно товара для возврата: "+deref(pl.rl.Name)+", остаток "+ing.Qty.String(), nil)
			}

			// stock_movement −qty. Хук stockAfterCreate сам вычтет из ingredients.qty
			// в этой же транзакции (прямой UPDATE qty запрещён).
			mvType := "return_supplier"
			desc := "return:" + returnID
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &mvType,
				IngredientID:   &ingID,
				IngredientName: pl.rl.Name,
				Description:    &desc,
				Qty:            stockQty.Neg(),
				Unit:           mvUnit,
				RestaurantID:   &rid,
				CreatedAt:      now,
			}
			if ing != nil {
				mv.WarehouseID = ing.WarehouseID
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}

			// Откат средневзвешенной себестоимости — обратная формула к приёмке:
			//   приход:  new = (old_qty*old_price + line_cost) / (old_qty + recv_qty)
			//   возврат: new = (old_qty*old_price − ret_cost)  / (old_qty − ret_qty)
			// Нужен, чтобы возврат дорогой партии не оставлял завышенную с/с во
			// всех блюдах: купили 10 кг по 10, потом 10 кг по 20 (с/с стала 15),
			// вернули вторую — на складе снова 10 кг по 10, с/с обязана стать 10.
			//
			// НО откат точен, только если с момента приёмки НЕ БЫЛО РАСХОДА.
			// Расход снимает стоимость по средней, а не из конкретной партии, и
			// связь «остаток ↔ партия» рвётся — формула тогда даёт цену, которой
			// не было ни в одной накладной. Реальный пример: 10 кг по 10 + 10 кг
			// по 20 (с/с 15), расход 5 кг, возврат 10 кг → num = 15*15 − 200 = 25,
			// denom = 5, цена 5.00 при физическом остатке 5 кг по 10.
			// Причина глубже арифметики: в средневзвешенной модели партий не
			// существует, поэтому «вернуть партию 2 целиком» после расхода —
			// операция без смысла. Был расход → цену не трогаем: 15 хотя бы
			// реальная историческая средняя, а не выдуманная.
			//
			// ret_cost — в единицах накладной, инвариант к конвертации (та же
			// логика, что в приёмке: сумма денег от единиц не зависит).
			if ing != nil && decimal.IsPositive(stockQty) {
				denom := decimal.Sub(ing.Qty, stockQty)
				num := decimal.Sub(decimal.Mul(ing.Qty, ing.PricePerUnit), pl.cost)
				// denom ≤ 0 — вернули весь остаток, цена бессмысленна (следующая
				// приёмка перезапишет её чистой ценой прихода, см. ветку
				// ing.Qty ≤ 0 в CreateReceipt). num < 0 — остаток стоит меньше
				// возвращаемого, такое возможно только после расхода.
				if !consumedSince[ingID] && decimal.IsPositive(denom) && !decimal.IsNegative(num) {
					newPrice := decimal.Normalize(decimal.DivRound(num, denom))
					if err := tx.Model(&models.Ingredient{}).
						Where("restaurant_id = ? AND id = ?", rid, ingID).
						Update("price_per_unit", newPrice).Error; err != nil {
						return err
					}
					ing.PricePerUnit = newPrice
					// Запоминаем на строке: сторно обязано сделать ровно обратное,
					// иначе цикл «возврат + сторно» завышает стоимость запасов
					// (см. миграцию 045).
					line.CostRolledBack = true
				}
				// In-memory qty для следующих строк того же ингредиента.
				ing.Qty = denom
			}

			if err := tx.Create(line).Error; err != nil {
				return err
			}
		}

		// Деньги.
		//
		// Обе ветки решает ОДНО число — debtRoom, остаток долга, который этот
		// возврат может погасить. Есть что гасить → возврат обязан гасить долг;
		// гасить нечего → деньги вернулись живыми. Без этого правила ветка money
		// выдавала деньги за неоплаченный товар, оставляя долг висеть (получали
		// и товар назад, и деньги, и долг — тройная выгода из воздуха).
		// sup уже под замком — взят в начале транзакции по каноническому порядку.
		// debtRoom = min(receipt.debt_amount, supplier.current_debt).
		// С v3.16.89 debt_amount — ОСТАТОК долга накладной (PayDebt раскладывает
		// оплату по накладным), а current_debt = Σ debt_amount, так что меньшее —
		// это почти всегда сама накладная. min() оставлен защитой: current_debt
		// денормализован и может разойтись (восстановление из бэкапа, дрейф) —
		// уехать в минус нельзя, GREATEST(0,…) в RecomputeDebts тихо съел бы
		// разницу, а за товар уже заплачено → деньгами.
		debtRoom := decimal.Zero
		if sup != nil && decimal.IsPositive(receipt.DebtAmount) && decimal.IsPositive(sup.CurrentDebt) {
			debtRoom = receipt.DebtAmount
			if sup.CurrentDebt.LessThan(debtRoom) {
				debtRoom = sup.CurrentDebt
			}
		}

		switch in.RefundType {
		case "debt":
			if !decimal.IsPositive(debtRoom) {
				return apperrors.Wrap("CONFLICT", "долга поставщику нет — оформите возврат деньгами", nil)
			}
			// Возврат больше остатка долга — это смешанный случай: часть гасит
			// долг, часть обязана вернуться деньгами. Автоматически разложить не
			// можем — оплаты долга живут per-supplier (по counterparty), а не
			// per-receipt, поэтому «сколько оплачено именно этой накладной»
			// система не знает. Отбиваем; кладовщик оформляет двумя документами
			// (сначала долг на debtRoom, остаток деньгами) — склад в обоих верен.
			if totalAmount.GreaterThan(debtRoom) {
				return apperrors.Wrap("CONFLICT", "возврат больше остатка долга ("+debtRoom.String()+") — оформите двумя документами: сначала долг, остаток деньгами", nil)
			}
			if err := tx.Model(&receipt).Updates(map[string]any{
				"debt_amount": decimal.Normalize(decimal.Sub(receipt.DebtAmount, totalAmount)),
				"updated_at":  now,
			}).Error; err != nil {
				return err
			}
			if err := tx.Model(sup).Updates(map[string]any{
				"current_debt": decimal.Normalize(decimal.Sub(sup.CurrentDebt, totalAmount)),
				"updated_at":   now,
			}).Error; err != nil {
				return err
			}
		case "money":
			// Есть непогашенный долг → деньги нельзя: за товар ещё не заплачено,
			// поставщик его не вернёт. Сначала гасим долг (ветка debt).
			// Накладная в долг без поставщика (debt_amount>0, sup=nil) тоже сюда
			// попадёт: долг ей начислен, но списать его не на кого — такую
			// накладную сначала чинят, проставляя поставщика.
			if decimal.IsPositive(receipt.DebtAmount) && (sup == nil || decimal.IsPositive(sup.CurrentDebt)) {
				return apperrors.Wrap("CONFLICT", "по накладной есть непогашенный долг — сначала уменьшите долг", nil)
			}
			// Деньги вернулись на счёт. category='stock_purchase' (не «доход»!) —
			// чтобы возврат схлопнулся с закупкой: ОПиУ берёт выручку из orders, а
			// opex фильтрует type='out', поэтому в отчёте не появится ни фейкового
			// дохода, ни отрицательного расхода. ДДС покажет реальный приток — и это
			// правда, деньги физически пришли.
			//
			// source_ref здесь — только для трассировки «откуда проводка», НЕ для
			// идемпотентности: uq_finops_tenant_receipt_source_ref частичный
			// (WHERE source_ref LIKE 'receipt:%'), префикс return: под него не
			// попадает, да и returnID новый на каждый вызов — коллизии не будет
			// в принципе. От повторной отправки защищает Idempotency-Key middleware
			// (см. миграцию 013, там это сказано прямым текстом).
			// acc уже под замком — взят выше по каноническому порядку.
			if err := tx.Model(acc).Updates(map[string]any{
				"balance":    decimal.Normalize(decimal.Add(acc.Balance, totalAmount)),
				"updated_at": now,
			}).Error; err != nil {
				return err
			}
			opType := "in"
			opCat := "stock_purchase"
			opActivity := "operational"
			opDate := date
			opSrc := "return:" + returnID
			isAuto := true
			opDesc := "Возврат поставщику"
			if receipt.SupplierName != nil && *receipt.SupplierName != "" {
				opDesc = "Возврат: " + *receipt.SupplierName
			}
			accID := *in.AccountID
			ridStr := rid
			if err := tx.Create(&models.FinancialOperation{
				ID:           uuid.NewString(),
				Type:         &opType,
				Amount:       totalAmount,
				Category:     &opCat,
				AccountID:    &accID,
				AccountName:  acc.Name,
				Activity:     &opActivity,
				Date:         &opDate,
				Description:  &opDesc,
				Counterparty: receipt.SupplierName,
				IsAuto:       &isAuto,
				SourceRef:    &opSrc,
				RestaurantID: &ridStr,
				CreatedAt:    now,
				UpdatedAt:    now,
			}).Error; err != nil {
				return err
			}
		}

		created = ret
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventStockMovement, map[string]any{
			"kind":         "return",
			"return_id":    created.ID,
			"receipt_id":   created.ReceiptID,
			"lines":        len(in.Lines),
			"total_amount": created.TotalAmount.String(),
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return created, nil
}

// CancelReturn — сторно возврата: товар приезжает назад на склад, деньги/долг
// откатываются. Строку не удаляем (документы append-only) — помечаем
// cancelled_at, а компенсацию проводим отдельными движениями, чтобы история
// читалась целиком.
//
// Склад отдаём обратно по формуле ПРИЁМКИ (средневзвешенная вперёд), а не
// «обратным откатом»: товар физически входит на склад по цене накладной — это
// ровно приёмка. Если исходный возврат цену откатывал (расхода не было), сторно
// вернёт её как было; если не откатывал (расход был) — цена сместится к цене
// накладной, что для входящего товара корректно.
func (s *StockService) CancelReturn(ctx context.Context, id string) (*models.StockReturn, error) {
	if err := requirePermFor(ctx, s.r, "inventory.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()

	var out *models.StockReturn
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		var ret models.StockReturn
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, id).First(&ret).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if ret.CancelledAt != nil {
			return apperrors.Wrap("CONFLICT", "возврат уже отменён", nil)
		}

		var lines []models.StockReturnLine
		if err := tx.Where("return_id = ?", ret.ID).Find(&lines).Error; err != nil {
			return err
		}

		// Канонический порядок замков (см. orders_perms.go): возврат → поставщик
		// → накладная → счёт → ингредиенты. Берём денежные замки ЗДЕСЬ, до
		// ингредиентов, хотя используем их ниже: порядок важнее локальности,
		// иначе дедлок с PayDebt и CreateReturn.
		var sup *models.Supplier
		if ret.SupplierID != nil && *ret.SupplierID != "" {
			var s models.Supplier
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, *ret.SupplierID).First(&s).Error; err != nil {
				return err
			}
			sup = &s
		}
		var receipt models.StockReceipt
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, ret.ReceiptID).First(&receipt).Error; err != nil {
			return err
		}
		var acc *models.FinancialAccount
		if ret.RefundType == "money" {
			if ret.AccountID == nil || *ret.AccountID == "" {
				return apperrors.Wrap("CONFLICT", "у возврата не указан счёт — сторно невозможно", nil)
			}
			var a models.FinancialAccount
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, *ret.AccountID).First(&a).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "account not found", err)
			}
			acc = &a
		}

		// Ингредиенты под замком — read-modify-write цены, как в приёмке.
		ingByID := make(map[string]*models.Ingredient)
		{
			ids := make([]string, 0, len(lines))
			seen := make(map[string]struct{})
			for i := range lines {
				id := deref(lines[i].IngredientID)
				if id == "" {
					continue
				}
				if _, ok := seen[id]; !ok {
					seen[id] = struct{}{}
					ids = append(ids, id)
				}
			}
			if len(ids) > 0 {
				var ings []models.Ingredient
				if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
					Where("restaurant_id = ? AND id IN ?", rid, ids).Order("id").Find(&ings).Error; err != nil {
					return err
				}
				for i := range ings {
					ingByID[ings[i].ID] = &ings[i]
				}
			}
		}

		for i := range lines {
			l := &lines[i]
			ingID := deref(l.IngredientID)
			if ingID == "" {
				continue
			}
			ing := ingByID[ingID]
			stockUnit := ""
			if ing != nil && ing.Unit != nil {
				stockUnit = *ing.Unit
			}
			stockQty := units.Convert(l.Qty, deref(l.Unit), stockUnit)
			mvUnit := l.Unit
			if stockUnit != "" {
				mvUnit = &stockUnit
			}

			// Компенсирующее движение +qty. Тип тот же (return_supplier), знак
			// обратный — в истории склада видно и возврат, и его сторно.
			mvType := "return_supplier"
			desc := "return_cancel:" + ret.ID
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &mvType,
				IngredientID:   &ingID,
				IngredientName: l.Name,
				Description:    &desc,
				Qty:            stockQty,
				Unit:           mvUnit,
				RestaurantID:   &rid,
				CreatedAt:      now,
			}
			if ing != nil {
				mv.WarehouseID = ing.WarehouseID
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}

			// Цену трогаем ТОЛЬКО если возврат её откатывал — сторно обязано быть
			// зеркалом, а не самостоятельным решением. Возврат откатывает цену
			// лишь когда с момента приёмки не было расхода; если он цену не
			// трогал, а сторно применит формулу приёмки, цикл «возврат + сторно»
			// вернёт не исходное состояние, а завышенную стоимость запасов:
			// 225 → 75 → 275, и 50 уедет в COGS (см. миграцию 045).
			if ing != nil && decimal.IsPositive(stockQty) && l.CostRolledBack {
				cost := decimal.Mul(l.Qty, l.PricePerUnit)
				denom := decimal.Add(ing.Qty, stockQty)
				var newPrice decimal.Decimal
				if decimal.IsPositive(denom) && !decimal.IsNegative(ing.Qty) {
					newPrice = decimal.DivRound(decimal.Add(decimal.Mul(ing.Qty, ing.PricePerUnit), cost), denom)
				} else {
					// Остаток был отрицательным/нулевым — историческая стоимость
					// невалидна, берём чистую цену накладной (как в CreateReceipt).
					newPrice = decimal.DivRound(cost, stockQty)
				}
				newPrice = decimal.Normalize(newPrice)
				if err := tx.Model(&models.Ingredient{}).
					Where("restaurant_id = ? AND id = ?", rid, ingID).
					Update("price_per_unit", newPrice).Error; err != nil {
					return err
				}
				ing.PricePerUnit = newPrice
			}
			// Количество возвращается всегда — оно физически приехало назад.
			if ing != nil {
				ing.Qty = decimal.Add(ing.Qty, stockQty)
			}
		}

		// Деньги — зеркало того, что сделал возврат. Все замки уже взяты выше
		// в каноническом порядке.
		switch ret.RefundType {
		case "debt":
			// Долг возвращается на место: и накладной, и поставщику.
			if err := tx.Model(&receipt).Updates(map[string]any{
				"debt_amount": decimal.Normalize(decimal.Add(receipt.DebtAmount, ret.TotalAmount)),
				"updated_at":  now,
			}).Error; err != nil {
				return err
			}
			if sup != nil {
				if err := tx.Model(sup).Updates(map[string]any{
					"current_debt": decimal.Normalize(decimal.Add(sup.CurrentDebt, ret.TotalAmount)),
					"updated_at":   now,
				}).Error; err != nil {
					return err
				}
			}
		case "money":
			// Деньги уходят обратно поставщику: снимаем со счёта встречной
			// проводкой out/stock_purchase — она схлопнется с приходом возврата,
			// и в ДДС период сойдётся в ноль.
			newBal := decimal.Normalize(decimal.Sub(acc.Balance, ret.TotalAmount))
			if decimal.IsNegative(newBal) {
				return apperrors.Wrap("CONFLICT", "на счёте недостаточно денег, чтобы отменить возврат", nil)
			}
			// acc — уже указатель (взят под замком выше): &acc дал бы GORM
			// двойной указатель — компилируется, падает в рантайме.
			if err := tx.Model(acc).Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
				return err
			}
			opType := "out"
			opCat := "stock_purchase"
			opActivity := "operational"
			opDate := now.Format("2006-01-02")
			opSrc := "return_cancel:" + ret.ID
			isAuto := true
			opDesc := "Отмена возврата"
			if ret.SupplierName != nil && *ret.SupplierName != "" {
				opDesc = "Отмена возврата: " + *ret.SupplierName
			}
			accID := *ret.AccountID
			ridStr := rid
			if err := tx.Create(&models.FinancialOperation{
				ID:           uuid.NewString(),
				Type:         &opType,
				Amount:       ret.TotalAmount,
				Category:     &opCat,
				AccountID:    &accID,
				AccountName:  acc.Name,
				Activity:     &opActivity,
				Date:         &opDate,
				Description:  &opDesc,
				Counterparty: ret.SupplierName,
				IsAuto:       &isAuto,
				SourceRef:    &opSrc,
				RestaurantID: &ridStr,
				CreatedAt:    now,
				UpdatedAt:    now,
			}).Error; err != nil {
				return err
			}
		}

		cancelledBy := actor.UserID
		if err := tx.Model(&ret).Updates(map[string]any{
			"cancelled_at": now,
			"cancelled_by": cancelledBy,
			"updated_at":   now,
		}).Error; err != nil {
			return err
		}
		ret.CancelledAt = &now
		ret.CancelledBy = &cancelledBy
		out = &ret
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventStockMovement, map[string]any{
			"kind":         "return_cancel",
			"return_id":    out.ID,
			"receipt_id":   out.ReceiptID,
			"total_amount": out.TotalAmount.String(),
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return out, nil
}

// ReturnsFilter — фильтры GET /api/v1/stock/returns.
type ReturnsFilter struct {
	SupplierID string
	ReceiptID  string
	From, To   *time.Time
	Page       cursor.Page
}

// ReturnWithLines — DTO для GET /stock/returns?include=lines.
type ReturnWithLines struct {
	*models.StockReturn
	Lines []models.StockReturnLine `json:"lines"`
}

func (s *StockReadsService) ListReturns(ctx context.Context, f ReturnsFilter) ([]models.StockReturn, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.SupplierID != "" {
		q = q.Where("supplier_id = ?", f.SupplierID)
	}
	if f.ReceiptID != "" {
		q = q.Where("receipt_id = ?", f.ReceiptID)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	q = cursor.Apply(q, "stock_returns", f.Page)
	var rows []models.StockReturn
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.StockReturn) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

// ListReturnsWithLines — то же, но с lines одним батч-SELECT по return_id IN (...).
func (s *StockReadsService) ListReturnsWithLines(ctx context.Context, f ReturnsFilter) ([]ReturnWithLines, string, error) {
	rows, next, err := s.ListReturns(ctx, f)
	if err != nil {
		return nil, "", err
	}
	if len(rows) == 0 {
		return []ReturnWithLines{}, next, nil
	}
	ids := make([]string, 0, len(rows))
	for i := range rows {
		ids = append(ids, rows[i].ID)
	}
	// stock_return_lines не имеет restaurant_id; return_id IN ids (отскоупленные)
	// — единственный безопасный фильтр.
	var lines []models.StockReturnLine
	if err := s.r.Raw().WithContext(ctx).
		Where("return_id IN ?", ids).Find(&lines).Error; err != nil {
		return nil, "", err
	}
	byReturn := make(map[string][]models.StockReturnLine, len(rows))
	for _, l := range lines {
		byReturn[l.ReturnID] = append(byReturn[l.ReturnID], l)
	}
	out := make([]ReturnWithLines, len(rows))
	for i := range rows {
		r := rows[i]
		ls := byReturn[r.ID]
		if ls == nil {
			ls = []models.StockReturnLine{}
		}
		out[i] = ReturnWithLines{StockReturn: &r, Lines: ls}
	}
	return out, next, nil
}
