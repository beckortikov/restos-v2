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
		returned := make(map[string]decimal.Decimal, len(rLines))
		if len(ids) > 0 {
			var rows []struct {
				ReceiptLineID string          `gorm:"column:receipt_line_id"`
				Qty           decimal.Decimal `gorm:"column:qty"`
			}
			if err := tx.Model(&models.StockReturnLine{}).
				Select("receipt_line_id, COALESCE(SUM(qty), 0) AS qty").
				Where("receipt_line_id IN ?", ids).
				Group("receipt_line_id").Scan(&rows).Error; err != nil {
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
				return apperrors.Wrap("CONFLICT", "return exceeds received qty for line "+rl.ID, nil)
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
					Find(&ings).Error; err != nil {
					return err
				}
				for i := range ings {
					ingByID[ings[i].ID] = &ings[i]
				}
			}
		}

		for _, pl := range parsedLines {
			if err := tx.Create(&models.StockReturnLine{
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
			}).Error; err != nil {
				return err
			}
			ingID := deref(pl.rl.IngredientID)
			if ingID == "" {
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
			// Без отката: купили 10 кг по 10, потом 10 кг по 20 (с/с стала 15),
			// вернули битую вторую партию — на складе снова 10 кг по 10, а с/с
			// осталась 15, и все блюда считаются с завышенной себестоимостью.
			// ret_cost — в единицах накладной, инвариант к конвертации (та же
			// логика, что в приёмке: сумма денег от единиц не зависит).
			if ing != nil && decimal.IsPositive(stockQty) {
				denom := decimal.Sub(ing.Qty, stockQty)
				num := decimal.Sub(decimal.Mul(ing.Qty, ing.PricePerUnit), pl.cost)
				// denom ≤ 0 (вернули весь остаток) или num < 0 (историческая
				// стоимость меньше возвращаемой — остаток уже уходил в минус):
				// пересчитывать нечего, цену оставляем прежней. Следующая приёмка
				// перезапишет её чистой ценой прихода (ветка ing.Qty ≤ 0 в CreateReceipt).
				if decimal.IsPositive(denom) && !decimal.IsNegative(num) {
					newPrice := decimal.Normalize(decimal.DivRound(num, denom))
					if err := tx.Model(&models.Ingredient{}).
						Where("restaurant_id = ? AND id = ?", rid, ingID).
						Update("price_per_unit", newPrice).Error; err != nil {
						return err
					}
					ing.PricePerUnit = newPrice
				}
				// In-memory qty для следующих строк того же ингредиента.
				ing.Qty = denom
			}
		}

		// Деньги.
		//
		// Смешанный случай (накладная оплачена частично, а возврат больше остатка
		// долга) намеренно НЕ раскладываем автоматически: оплаты долга живут
		// per-supplier (financial_operations category='supplier_payment' по
		// counterparty), а не per-receipt — «сколько оплачено именно этой
		// накладной» система не знает. Вместо тихой ошибки в деньгах guard'ы ниже
		// отбивают такой возврат с подсказкой; кладовщик оформляет его двумя
		// документами (часть в долг, часть деньгами) — склад в обоих корректен.
		switch in.RefundType {
		case "debt":
			// receipts.debt_amount — НАЧИСЛЕННЫЙ долг накладной; оплаты вычитаются
			// отдельно в RecomputeDebts (Σ debt_amount − Σ supplier_payment).
			// Поэтому уменьшаем именно debt_amount: формула пересчёта остаётся
			// верной. Уменьшить только suppliers.current_debt нельзя — первый же
			// RecomputeDebts воскресит долг.
			if !decimal.IsPositive(receipt.DebtAmount) {
				return apperrors.Wrap("CONFLICT", "receipt has no debt: use refund_type=money", nil)
			}
			if totalAmount.GreaterThan(receipt.DebtAmount) {
				return apperrors.Wrap("CONFLICT", "return exceeds receipt debt: use refund_type=money", nil)
			}
			if receipt.SupplierID == nil || *receipt.SupplierID == "" {
				return apperrors.Wrap("CONFLICT", "receipt has no supplier: use refund_type=money", nil)
			}
			var sup models.Supplier
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, *receipt.SupplierID).First(&sup).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "supplier not found", err)
			}
			// Долг уже погашен через pay-debt — уменьшать нечего. Без этой проверки
			// GREATEST(0,…) в RecomputeDebts тихо съел бы разницу: за товар уже
			// заплачено, поставщик обязан вернуть деньгами.
			if totalAmount.GreaterThan(sup.CurrentDebt) {
				return apperrors.Wrap("CONFLICT", "return exceeds current supplier debt: use refund_type=money", nil)
			}
			if err := tx.Model(&receipt).Updates(map[string]any{
				"debt_amount": decimal.Normalize(decimal.Sub(receipt.DebtAmount, totalAmount)),
				"updated_at":  now,
			}).Error; err != nil {
				return err
			}
			if err := tx.Model(&sup).Updates(map[string]any{
				"current_debt": decimal.Normalize(decimal.Sub(sup.CurrentDebt, totalAmount)),
				"updated_at":   now,
			}).Error; err != nil {
				return err
			}
		case "money":
			// Деньги вернулись на счёт. category='stock_purchase' (не «доход»!) —
			// чтобы возврат схлопнулся с закупкой: ОПиУ берёт выручку из orders, а
			// opex фильтрует type='out', поэтому в отчёте не появится ни фейкового
			// дохода, ни отрицательного расхода. ДДС покажет реальный приток — и это
			// правда, деньги физически пришли. source_ref + UNIQUE(restaurant_id,
			// source_ref) → повтор запроса не задвоит проводку.
			var acc models.FinancialAccount
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, *in.AccountID).First(&acc).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "account not found", err)
			}
			if err := tx.Model(&acc).Updates(map[string]any{
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
