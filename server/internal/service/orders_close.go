package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
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
	if in.PaymentMethod == "" || in.ShiftID == "" {
		return nil, nil, apperrors.Wrap("VALIDATION", "payment_method and shift_id are required", nil)
	}
	tip := decimal.Zero
	if in.TipAmount != "" {
		tip, err = decimal.FromString(in.TipAmount)
		if err != nil {
			return nil, nil, apperrors.Wrap("VALIDATION", "bad tip_amount", err)
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
		pm := in.PaymentMethod
		order.PaymentMethod = &pm
		order.TipAmount = tip
		// Если нужно service-percent — добавить позже из restaurants.service_percent.
		// Пока total_with_service = total + tip.
		order.TotalWithService = decimal.Normalize(decimal.Add(order.Total, tip))
		if err := tx.Save(&order).Error; err != nil {
			return err
		}

		// 5. Revenue financial_operation.
		opType := "in"
		opCat := "revenue"
		opActivity := "operational"
		opAccount := in.AccountID
		opDate := now.Format("2006-01-02")
		opDesc := "order:" + order.ID
		opAuto := true
		opSourceRef := "order:" + order.ID
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

		// 7. Update shift aggregates.
		switch in.PaymentMethod {
		case "cash":
			shift.CashRevenue = decimal.Add(shift.CashRevenue, order.TotalWithService)
		case "card":
			shift.CardRevenue = decimal.Add(shift.CardRevenue, order.TotalWithService)
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
		if err := s.enqueueReceipt(tx, rid, &order, in.PaymentMethod, now); err != nil {
			// Не валим транзакцию из-за печати — клиент может перепечатать вручную.
			// Но логируем как warning.
			// log в worker'е увидим всё равно — здесь оставим без явного логирования.
			_ = err
		}

		closed = &order
		buf.Add(EventOrderClosed, map[string]any{
			"id":                 order.ID,
			"total_with_service": order.TotalWithService.String(),
			"payment_method":     in.PaymentMethod,
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
