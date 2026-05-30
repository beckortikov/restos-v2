package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/escpos"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// PrintPreBillResult — что вернули клиенту.
type PrintPreBillResult struct {
	JobID  string `json:"job_id"`
	Status string `json:"status"`
}

// PrintPreBill — печатает предварительный чек (пре-чек, «счёт для гостя»).
//
// Отличия от Close:
//   - заказ НЕ закрывается, остаётся в текущем статусе;
//   - НЕ создаются financial_operations / revenue;
//   - НЕ списывается stock;
//   - layout — PreBillLayout (без «Оплата», с дисклеймером).
//
// Просто кладёт PrintJob type='pre_bill' в очередь; worker отправит на принтер.
// Можно вызывать многократно (каждый вызов = новый job).
func (s *OrdersService) PrintPreBill(ctx context.Context, orderID string) (*PrintPreBillResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var res PrintPreBillResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// 1. Load order (без lock — мы не мутируем заказ).
		var order models.Order
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, orderID).
			First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if order.Status != nil && *order.Status == "cancelled" {
			return apperrors.Wrap("CONFLICT", "cannot print pre-bill for cancelled order", nil)
		}

		// 2. Items (только активные).
		var items []models.OrderItem
		if err := tx.Where("order_id = ? AND cancelled_at IS NULL", order.ID).
			Order("created_at ASC").
			Find(&items).Error; err != nil {
			return err
		}
		if len(items) == 0 {
			return apperrors.Wrap("VALIDATION", "order has no items to print", nil)
		}

		// 3. Restaurant header.
		var rest models.Restaurant
		if err := tx.Where("id = ?", rid).First(&rest).Error; err != nil {
			return err
		}

		now := time.Now().UTC()

		// 4. Build layout input — пересчитываем total на лету (заказ не закрыт,
		// сервис/чаевые ещё не зафиксированы). Используем текущий order.Total
		// + service по проценту ресторана; tip не известен.
		subtotal := order.Total
		serviceAmount := order.ServiceAmount
		if !order.ServicePercent.IsZero() && serviceAmount.IsZero() {
			serviceAmount = decimal.Normalize(decimal.Percent(subtotal, order.ServicePercent))
		}
		total := decimal.Normalize(decimal.Add(subtotal, serviceAmount))

		in := escpos.ReceiptInput{
			RestaurantName: rest.Name,
			OrderNumber:    order.OrderNumber,
			OpenedAt:       order.CreatedAt,
			ClosedAt:       now,
			Subtotal:       subtotal,
			DiscountAmount: order.DiscountAmount,
			ServiceAmount:  serviceAmount,
			Total:          total,
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

		payload := escpos.PreBillLayout(in)

		// 5. Enqueue print_job.
		pj := &models.PrintJob{
			ID:           uuid.NewString(),
			Type:         "pre_bill",
			Payload:      payload,
			OrderID:      &order.ID,
			Status:       "pending",
			RestaurantID: &rid,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Session(&gorm.Session{SkipHooks: true}).Create(pj).Error; err != nil {
			return err
		}
		res.JobID = pj.ID
		res.Status = pj.Status
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventOrderUpdated, map[string]any{
			"id":     orderID,
			"action": "pre_bill.printed",
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return &res, nil
}
