package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/escpos"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// CloseOrderInput — body POST /api/v1/orders/{id}/close.
type CloseOrderInput struct {
	PaymentMethod string `json:"payment_method"` // cash|card|transfer|...
	AccountID     string `json:"account_id"`     // financial_account, на который идёт revenue
	ShiftID       string `json:"shift_id"`       // обязателен, привязка к смене
	TipAmount     string `json:"tip_amount,omitempty"`

	// Кассир, фиксируется в order.cashier_id.
	CashierID *string `json:"cashier_id,omitempty"`

	// Скидка — применяется к total ДО формирования financial_operation.
	DiscountType   *string `json:"discount_type,omitempty"`  // "percent" | "fixed"
	DiscountValue  *string `json:"discount_value,omitempty"` // decimal string
	DiscountReason *string `json:"discount_reason,omitempty"`

	// Multi-payment. Если задан — payment_method/account_id игнорируются
	// (используются только если list пустой).
	Payments []PaymentSplit `json:"payments,omitempty"`

	// ServicePercent — % обслуживания, выбранный кассиром в момент close.
	// Если nil — берём order.ServicePercent (default ресторана). Если "0"
	// — сервис отключён для этого заказа. Хранится в order.service_percent
	// и используется при вычислении total_with_service.
	ServicePercent *string `json:"service_percent,omitempty"`
}

// PaymentSplit — одна часть split-payment.
type PaymentSplit struct {
	Method    string `json:"method"`     // cash|card|transfer
	Amount    string `json:"amount"`     // decimal string
	AccountID string `json:"account_id"` // financial_account UUID
}

// Close — критичный многошаговый flow закрытия заказа.
//
// Шаги (всё в ОДНОЙ транзакции):
//  1. Lock order FOR UPDATE; validate (status != closed).
//  2. Validate shift_id (status=open, той же ресторан).
//  3. Snapshot tip_amount → order.
//  4. order.status = "closed", order.closed_at = now, order.shift_id = shift_id,
//     order.payment_method = ..., order.total_with_service = total + service_amount.
//  5. Создаём financial_operation (type=in, category=revenue, source_ref=order:{id}, shift_id, account_id).
//  6. Деducтим stock через append-only stock_movements по tech_card_lines каждого item.
//     Идемпотентность списания через source_ref в description (один раз на order).
//  7. Обновляем cash_shifts.cash_revenue/card_revenue/orders_count.
//
// После commit:
//   - publish EventOrderClosed
//   - print job в print_jobs (fire-and-forget, отдельный worker печатает).
func (s *OrdersService) Close(ctx context.Context, orderID string, in CloseOrderInput) (*models.Order, *EventBuffer, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, nil, err
	}
	if in.ShiftID == "" {
		return nil, nil, apperrors.Wrap("VALIDATION", "shift_id is required", nil)
	}
	// При single-payment payment_method обязателен. При multi-payment проверим позже.
	if len(in.Payments) == 0 && in.PaymentMethod == "" {
		return nil, nil, apperrors.Wrap("VALIDATION", "payment_method is required when payments[] is empty", nil)
	}
	tip := decimal.Zero
	if in.TipAmount != "" {
		tip, err = decimal.FromString(in.TipAmount)
		if err != nil {
			return nil, nil, apperrors.Wrap("VALIDATION", "bad tip_amount", err)
		}
	}

	// Pre-validate discount fields (значение/тип проверим против order.Total внутри tx).
	var discountValue decimal.Decimal
	if in.DiscountType != nil {
		if *in.DiscountType != "percent" && *in.DiscountType != "fixed" {
			return nil, nil, apperrors.Wrap("VALIDATION", "discount_type must be 'percent' or 'fixed'", nil)
		}
		if in.DiscountValue == nil || *in.DiscountValue == "" {
			return nil, nil, apperrors.Wrap("VALIDATION", "discount_value is required when discount_type set", nil)
		}
		discountValue, err = decimal.FromString(*in.DiscountValue)
		if err != nil {
			return nil, nil, apperrors.Wrap("VALIDATION", "bad discount_value", err)
		}
		if decimal.IsNegative(discountValue) {
			return nil, nil, apperrors.Wrap("VALIDATION", "discount_value must be >= 0", nil)
		}
		if *in.DiscountType == "percent" && discountValue.GreaterThan(decimal.FromInt(100)) {
			return nil, nil, apperrors.Wrap("VALIDATION", "discount_value (percent) must be <= 100", nil)
		}
	}

	// Pre-validate payments[] shape.
	if len(in.Payments) > 0 {
		for i, p := range in.Payments {
			if p.Method != "cash" && p.Method != "card" && p.Method != "transfer" {
				return nil, nil, apperrors.Wrap("VALIDATION", "payments[].method must be cash|card|transfer", nil)
			}
			if p.AccountID == "" {
				return nil, nil, apperrors.Wrap("VALIDATION", "payments[].account_id is required", nil)
			}
			amt, perr := decimal.FromString(p.Amount)
			if perr != nil {
				return nil, nil, apperrors.Wrap("VALIDATION", "payments[].amount invalid", perr)
			}
			if decimal.IsNegative(amt) {
				return nil, nil, apperrors.Wrap("VALIDATION", "payments[].amount must be >= 0", nil)
			}
			_ = i
		}
	}

	buf := NewBuffer()
	var closed *models.Order

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// 1. Lock order.
		var order models.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if order.Status != nil && *order.Status == "closed" {
			return apperrors.Wrap("CONFLICT", "order already closed", nil)
		}

		// 2. Validate shift.
		var shift models.CashShift
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, in.ShiftID).
			First(&shift).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "shift not found", nil)
			}
			return err
		}
		if shift.Status == nil || *shift.Status != "open" {
			return apperrors.Wrap("CONFLICT", "shift is not open", nil)
		}

		// 3 + 4. Mutate order.
		now := time.Now().UTC()
		closedStatus := "closed"
		order.Status = &closedStatus
		order.ClosedAt = &now
		order.UpdatedAt = now
		shiftID := in.ShiftID
		order.ShiftID = &shiftID
		order.TipAmount = tip
		if in.CashierID != nil && *in.CashierID != "" {
			cid := *in.CashierID
			order.CashierID = &cid
		}

		// Рассчитываем discount от order.Total (без сервиса/чаевых).
		discountAmount := decimal.Zero
		if in.DiscountType != nil {
			switch *in.DiscountType {
			case "percent":
				discountAmount = decimal.Percent(order.Total, discountValue)
			case "fixed":
				discountAmount = decimal.Normalize(discountValue)
			}
			if discountAmount.GreaterThan(order.Total) {
				return apperrors.Wrap("VALIDATION", "discount exceeds order.total", nil)
			}
			dt := *in.DiscountType
			order.DiscountType = &dt
			order.DiscountValue = decimal.Normalize(discountValue)
			order.DiscountAmount = decimal.Normalize(discountAmount)
			if in.DiscountReason != nil {
				dr := *in.DiscountReason
				order.DiscountReason = &dr
			}
		}
		discountedTotal := decimal.Normalize(decimal.Sub(order.Total, discountAmount))
		if decimal.IsNegative(discountedTotal) {
			discountedTotal = decimal.Zero
		}
		// Service: либо переопределён в input (cashier выключил/включил toggle
		// в момент close), либо берём текущий order.service_percent (default
		// ресторана). Сохраняем как persistable snapshot.
		servicePercent := order.ServicePercent
		if in.ServicePercent != nil {
			sp, perr := decimal.FromString(*in.ServicePercent)
			if perr != nil {
				return apperrors.Wrap("VALIDATION", "bad service_percent", perr)
			}
			if decimal.IsNegative(sp) {
				return apperrors.Wrap("VALIDATION", "service_percent must be >= 0", nil)
			}
			servicePercent = decimal.Normalize(sp)
		}
		serviceAmount := decimal.Zero
		if !servicePercent.IsZero() {
			serviceAmount = decimal.Normalize(decimal.Percent(discountedTotal, servicePercent))
		}
		order.ServicePercent = servicePercent
		order.ServiceAmount = serviceAmount
		// total_with_service = (total - discount) + service + tip.
		order.TotalWithService = decimal.Normalize(decimal.Add(decimal.Add(discountedTotal, serviceAmount), tip))

		// Snapshot payment_method и payments (jsonb).
		expectedPayTotal := order.TotalWithService
		isMulti := len(in.Payments) > 0
		if isMulti {
			// Сумма split-ов должна совпадать с total_with_service (tolerance 0.01).
			sum := decimal.Zero
			for _, p := range in.Payments {
				amt, _ := decimal.FromString(p.Amount)
				sum = decimal.Add(sum, amt)
			}
			sumN := decimal.Normalize(sum)
			diff := decimal.Sub(sumN, expectedPayTotal).Abs()
			if diff.GreaterThan(decimal.MustFromString("0.01")) {
				return apperrors.Wrap("VALIDATION", "sum(payments[].amount) must equal total_with_service", nil)
			}
			split := "split"
			if len(in.Payments) == 1 {
				m := in.Payments[0].Method
				order.PaymentMethod = &m
			} else {
				order.PaymentMethod = &split
			}
			isSplit := len(in.Payments) > 1
			order.IsSplit = &isSplit
			sc := len(in.Payments)
			order.SplitCount = &sc
			if jsonBytes, jerr := json.Marshal(in.Payments); jerr == nil {
				order.Payments = datatypes.JSON(jsonBytes)
			}
		} else {
			pm := in.PaymentMethod
			order.PaymentMethod = &pm
		}
		if err := tx.Save(&order).Error; err != nil {
			return err
		}

		// 5. Revenue financial_operations (один или несколько split-ов).
		opType := "in"
		opCat := "revenue"
		opActivity := "operational"
		opDate := now.Format("2006-01-02")
		// description видит пользователь в /finance/accounts и /finance/cashflow.
		// Раньше писали "order:<UUID>" — UI показывал длинный хэш. Используем
		// порядковый номер per restaurant per day (v2.0.21).
		opDesc := fmt.Sprintf("Заказ #%d", order.OrderNumber)
		opAuto := true
		// source_ref остаётся machine-readable для идемпотентности и audit-связи.
		opSourceRef := "order:" + order.ID

		type payApplied struct {
			Method string
			Amount decimal.Decimal
		}
		var applied []payApplied

		// creditAccount инкрементит balance счёта на amount. Раньше Close
		// создавал financial_operation, но balance счёта не двигал —
		// ДДС показывал операции, а «Касса» в UI стояла на opening_balance.
		// Идемпотентность по source_ref уже обеспечена check'ом stock-deduct'а
		// выше (один финoperation на order — нет double-credit'а на ретрае).
		creditAccount := func(accountID string, amount decimal.Decimal) error {
			return tx.Model(&models.FinancialAccount{}).
				Where("restaurant_id = ? AND id = ?", rid, accountID).
				Updates(map[string]any{
					"balance":    gorm.Expr("balance + ?", amount),
					"updated_at": now,
				}).Error
		}

		if isMulti {
			for _, p := range in.Payments {
				amt, _ := decimal.FromString(p.Amount)
				amtN := decimal.Normalize(amt)
				acc := p.AccountID
				finOp := &models.FinancialOperation{
					ID:           uuid.NewString(),
					Type:         &opType,
					Amount:       amtN,
					Category:     &opCat,
					Activity:     &opActivity,
					AccountID:    &acc,
					Date:         &opDate,
					Description:  &opDesc,
					IsAuto:       &opAuto,
					SourceRef:    &opSourceRef,
					RestaurantID: &rid,
					ShiftID:      &shiftID,
					CreatedAt:    now,
					UpdatedAt:    now,
				}
				if err := tx.Create(finOp).Error; err != nil {
					return err
				}
				if err := creditAccount(acc, amtN); err != nil {
					return err
				}
				applied = append(applied, payApplied{Method: p.Method, Amount: amtN})
			}
		} else {
			opAccount := in.AccountID
			finOp := &models.FinancialOperation{
				ID:           uuid.NewString(),
				Type:         &opType,
				Amount:       order.TotalWithService,
				Category:     &opCat,
				Activity:     &opActivity,
				AccountID:    &opAccount,
				Date:         &opDate,
				Description:  &opDesc,
				IsAuto:       &opAuto,
				SourceRef:    &opSourceRef,
				RestaurantID: &rid,
				ShiftID:      &shiftID,
				CreatedAt:    now,
				UpdatedAt:    now,
			}
			if err := tx.Create(finOp).Error; err != nil {
				return err
			}
			if err := creditAccount(opAccount, order.TotalWithService); err != nil {
				return err
			}
			applied = append(applied, payApplied{Method: in.PaymentMethod, Amount: order.TotalWithService})
		}

		// 6. Stock deduct через tech_card_lines.
		//
		// Идемпотентность: смотрим, не было ли уже movements для этого заказа.
		// description = "order:{id}" — наша конвенция.
		var existing int64
		if err := tx.Model(&models.StockMovement{}).
			Where("restaurant_id = ? AND description = ?", rid, opSourceRef).
			Count(&existing).Error; err != nil {
			return err
		}
		if existing == 0 {
			if err := s.deductStockForOrder(tx, rid, &order, opSourceRef, now); err != nil {
				return err
			}
		}

		// 7. Update shift aggregates (по каждому payment split-у отдельно).
		for _, p := range applied {
			switch p.Method {
			case "cash":
				shift.CashRevenue = decimal.Add(shift.CashRevenue, p.Amount)
			case "card":
				shift.CardRevenue = decimal.Add(shift.CardRevenue, p.Amount)
			}
		}
		ordersCount := 1
		if shift.OrdersCount != nil {
			ordersCount = *shift.OrdersCount + 1
		}
		shift.OrdersCount = &ordersCount
		// avg_check пересчитываем: (cash+card)/count
		total := decimal.Add(shift.CashRevenue, shift.CardRevenue)
		shift.AvgCheck = decimal.Normalize(decimal.DivRound(total, decimal.FromInt(int64(ordersCount))))
		shift.UpdatedAt = now
		if err := tx.Save(&shift).Error; err != nil {
			return err
		}

		// 8. Enqueue receipt print job (fire-and-forget: worker отправит после commit).
		receiptPM := ""
		if order.PaymentMethod != nil {
			receiptPM = *order.PaymentMethod
		}
		if err := s.enqueueReceipt(tx, rid, &order, receiptPM, now); err != nil {
			// Не валим транзакцию из-за печати — клиент может перепечатать вручную.
			// Но логируем как warning.
			// log в worker'е увидим всё равно — здесь оставим без явного логирования.
			_ = err
		}

		// Если на этом столе больше нет активных заказов — освобождаем его.
		// Активные статусы — те же, что считает резерв в computeReservations
		// (open/new/cooking/ready) + bill_requested/served (заказ ещё не закрыт).
		if order.TableID != nil && *order.TableID != "" {
			var activeCount int64
			if err := tx.Model(&models.Order{}).
				Where("restaurant_id = ? AND table_id = ?", rid, *order.TableID).
				Where("status IN ?", []string{"new", "open", "cooking", "ready", "served", "bill_requested"}).
				Where("id <> ?", order.ID).
				Count(&activeCount).Error; err != nil {
				return err
			}
			if activeCount == 0 {
				if err := tx.Model(&models.Table{}).
					Where("id = ? AND restaurant_id = ?", *order.TableID, rid).
					Updates(map[string]any{
						"status":           "free",
						"current_order_id": nil,
						"opened_at":        nil,
						"updated_at":       now,
					}).Error; err != nil {
					return err
				}
				buf.Add(EventTableUpdated, map[string]any{"id": *order.TableID})
			}
		}

		closed = &order
		buf.Add(EventOrderClosed, map[string]any{
			"id":                 order.ID,
			"total_with_service": order.TotalWithService.String(),
			"payment_method":     receiptPM,
			"shift_id":           in.ShiftID,
		})
		return nil
	})
	if err != nil {
		return nil, nil, err
	}
	s.publish(ctx, rid, buf)
	return closed, buf, nil
}

// deductStockForOrder списывает ингредиенты по tech_card_lines для каждой позиции
// заказа. Append-only через stock_movements. Денормализация ingredients.qty
// сделается отдельным механизмом (AfterCreate hook на StockMovement) или
// прямым UPDATE (см. PRD 06). Пока — только запись movements.
func (s *OrdersService) deductStockForOrder(tx *gorm.DB, restaurantID string, order *models.Order, sourceRef string, now time.Time) error {
	// 1. Загружаем все order_items этого заказа.
	var items []models.OrderItem
	if err := tx.Where("order_id = ?", order.ID).
		Where("cancelled_at IS NULL").
		Find(&items).Error; err != nil {
		return err
	}
	if len(items) == 0 {
		return nil
	}

	// 2. Загружаем tech_card_lines для всех menu_item_id одним запросом.
	menuIDs := make([]string, 0, len(items))
	for _, it := range items {
		if it.MenuItemID != nil {
			menuIDs = append(menuIDs, *it.MenuItemID)
		}
	}
	if len(menuIDs) == 0 {
		return nil
	}
	var lines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id IN ?", restaurantID, menuIDs).
		Find(&lines).Error; err != nil {
		return err
	}
	linesByMenu := make(map[string][]models.TechCardLine)
	for _, l := range lines {
		if l.MenuItemID == nil {
			continue
		}
		linesByMenu[*l.MenuItemID] = append(linesByMenu[*l.MenuItemID], l)
	}

	// 3. Для каждой позиции × tech_card_line — создаём StockMovement (qty<0 = списание).
	for _, it := range items {
		if it.MenuItemID == nil {
			continue
		}
		tcl := linesByMenu[*it.MenuItemID]
		for _, line := range tcl {
			if line.IngredientID == nil {
				// semi_finished — пропускаем в MVP (отдельная логика production-recipe).
				continue
			}
			deduct := decimal.Normalize(decimal.Mul(line.Qty, it.Qty)).Neg()
			desc := sourceRef
			opType := "out"
			unit := line.Unit
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &opType,
				IngredientID:   line.IngredientID,
				IngredientName: line.Name,
				Description:    &desc,
				Qty:            deduct,
				Unit:           unit,
				RestaurantID:   &restaurantID,
				CreatedAt:      now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
		}
	}
	return nil
}

// enqueueReceipt создаёт строку в print_jobs с готовым ESC/POS payload'ом
// чека клиенту. Работает В ТРАНЗАКЦИИ close_order: если транзакция откатится,
// job не запишется → не будет попыток печатать несуществующий заказ.
//
// Worker (internal/printer/queue.go) подберёт pending job на следующем тике
// и отправит на принтер.
func (s *OrdersService) enqueueReceipt(tx *gorm.DB, restaurantID string, order *models.Order, paymentMethod string, now time.Time) error {
	// 1. Грузим order_items для чека.
	var items []models.OrderItem
	if err := tx.Where("order_id = ? AND cancelled_at IS NULL", order.ID).
		Order("created_at ASC").
		Find(&items).Error; err != nil {
		return err
	}
	if len(items) == 0 {
		return nil // пустой заказ нечего печатать
	}

	// 2. Грузим имя ресторана для шапки.
	var rest models.Restaurant
	if err := tx.Where("id = ?", restaurantID).First(&rest).Error; err != nil {
		return err
	}

	// 3. Готовим input layout.
	in := escpos.ReceiptInput{
		RestaurantName: rest.Name,
		OrderNumber:    order.OrderNumber,
		OpenedAt:       order.CreatedAt,
		ClosedAt:       now,
		PaymentMethod:  paymentMethod,
		Subtotal:       order.Total,
		ServiceAmount:  order.ServiceAmount,
		TipAmount:      order.TipAmount,
		Total:          order.TotalWithService,
	}
	if rest.Address != nil {
		in.RestaurantAddr = *rest.Address
	}
	for _, it := range items {
		ri := escpos.ReceiptItem{
			Qty:       it.Qty,
			Price:     it.Price,
			LineTotal: decimal.Normalize(decimal.Mul(it.Price, it.Qty)),
		}
		if it.Name != nil {
			ri.Name = *it.Name
		}
		if it.Note != nil {
			ri.Note = *it.Note
		}
		in.Items = append(in.Items, ri)
	}

	payload := escpos.ReceiptLayout(in)

	// 4. Insert в print_jobs.
	pj := &models.PrintJob{
		ID:           uuid.NewString(),
		Type:         "receipt",
		Payload:      payload,
		OrderID:      &order.ID,
		Status:       "pending",
		RestaurantID: &restaurantID,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	// SkipHooks: print_jobs не пишем в audit.
	return tx.Session(&gorm.Session{SkipHooks: true}).Create(pj).Error
}
