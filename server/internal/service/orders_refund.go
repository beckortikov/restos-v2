package service

import (
	"context"
	jsonStdPkg "encoding/json"
	"errors"
	"fmt"
	"strings"
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

// ═══════════════════════════════════════════════════════════════════════════
// Refund — частичный/полный возврат денег по закрытому заказу.
// ═══════════════════════════════════════════════════════════════════════════

// refundOpDescPrefix — префикс описания финоперации возврата и её кассового
// зеркала (cash_out). ZReport по нему отличает возвраты от прочих авто-зеркал
// (выплаты/списания со счёта): возврат-зеркало исключается из «Расходов» и
// показывается отдельной строкой «Возвраты» (сумма + кол-во чеков).
const refundOpDescPrefix = "Возврат заказа #"

// RefundOrderInput — body POST /api/v1/orders/{id}/refund.
type RefundOrderInput struct {
	Reason string  `json:"reason"`
	Amount *string `json:"amount,omitempty"` // nil → полный возврат остатка
}

// RefundResult — ответ.
type RefundResult struct {
	OrderID  string          `json:"order_id"`
	Refunded decimal.Decimal `json:"refunded"`
}

// Refund — POST /api/v1/orders/{id}/refund.
//
// Шаги (в одной транзакции):
//  1. Lock order; проверяем status='closed' (или 'done' legacy) и наличие refundable amount.
//  2. Считаем сумму: либо in.Amount, либо order.TotalWithService - order.RefundedTotal.
//  3. Валидируем 0 < amount <= remaining.
//  4. UPDATE orders SET refunded_total += amount, refunded_at, refund_reason; если
//     refunded_total == total_with_service → status='refunded'.
//  5. INSERT financial_operations type='out' / activity='operational'.
//  6. publish EventOrderUpdated.
func (s *OrdersService) Refund(ctx context.Context, orderID string, in RefundOrderInput) (*RefundResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if err := s.requirePerm(ctx, "orders.refund"); err != nil {
		return nil, err
	}
	reason := strings.TrimSpace(in.Reason)
	if reason == "" {
		return nil, apperrors.Wrap("VALIDATION", "reason is required", nil)
	}

	var inputAmount *decimal.Decimal
	if in.Amount != nil && *in.Amount != "" {
		a, perr := decimal.FromString(*in.Amount)
		if perr != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad amount", perr)
		}
		if decimal.IsNegative(a) || a.IsZero() {
			return nil, apperrors.Wrap("VALIDATION", "amount must be > 0", nil)
		}
		an := decimal.Normalize(a)
		inputAmount = &an
	}

	buf := NewBuffer()
	var refunded decimal.Decimal

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		var order models.Order
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, orderID).
			First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		status := ""
		if order.Status != nil {
			status = *order.Status
		}
		if status != "closed" && status != "done" && status != "refunded" {
			return apperrors.Wrap("CONFLICT", "order must be closed before refund", nil)
		}

		paid := order.TotalWithService
		if paid.IsZero() {
			// fallback на total, если total_with_service не выставлен
			paid = order.Total
		}
		remaining := decimal.Normalize(decimal.Sub(paid, order.RefundedTotal))
		if !decimal.IsPositive(remaining) {
			return apperrors.Wrap("CONFLICT", "order already fully refunded", nil)
		}

		amount := remaining
		if inputAmount != nil {
			amount = *inputAmount
			if amount.GreaterThan(remaining) {
				return apperrors.Wrap("VALIDATION", "amount exceeds remaining refundable", nil)
			}
		}

		now := time.Now().UTC()
		// Первый возврат по заказу — уведомляем кухню (как при отмене). Повторные
		// частичные возвраты кухонный чек не дублируют.
		firstRefund := !decimal.IsPositive(order.RefundedTotal)
		newRefundedTotal := decimal.Normalize(decimal.Add(order.RefundedTotal, amount))
		order.RefundedTotal = newRefundedTotal
		order.RefundedAt = &now
		order.RefundReason = &reason
		order.UpdatedAt = now
		if !newRefundedTotal.LessThan(paid) {
			refundedStatus := "refunded"
			order.Status = &refundedStatus
		}
		if err := tx.Save(&order).Error; err != nil {
			return err
		}
		// Sync-дельта (ADR-003 Фаза 5) — заказ вернулся к терминальному
		// снимку (частичный/полный refund).
		if err := recordOrderSync(tx, &order, "update"); err != nil {
			return err
		}

		// financial_operation: возврат — type='out', activity='operational'.
		// account_id — снимаем со счёта первой записи приёма (если знаем),
		// иначе берём шiftу-default. Чтобы не усложнять, используем account_id
		// из payments[0] либо order.payment_method-based default.
		var accountID string
		// 1) попытка взять из payments JSON.
		if len(order.Payments) > 0 {
			// payments shape: [{method, amount, account_id}]
			var arr []map[string]any
			_ = jsonUnmarshal(order.Payments, &arr)
			for _, p := range arr {
				if s, ok := p["account_id"].(string); ok && s != "" {
					accountID = s
					break
				}
			}
		}
		// 2) fallback — find first finOp by source_ref=order:<id>.
		if accountID == "" {
			var firstOp models.FinancialOperation
			if err := tx.Where("restaurant_id = ? AND source_ref = ?", rid, "order:"+order.ID).
				Order("created_at ASC").
				Limit(1).
				First(&firstOp).Error; err == nil && firstOp.AccountID != nil {
				accountID = *firstOp.AccountID
			}
		}
		// 3) fallback для заказов, оплаченных РАЗДЕЛЕНИЕМ счёта (split): у них нет
		// ни payments JSON, ни order-level FO — только оплаченные order_splits со
		// своим account_id. Раньше это давало 409 «cannot determine source account»
		// → split-заказы вообще нельзя было вернуть. Берём счёт первого оплаченного
		// split'а (весь возврат идёт с него).
		if accountID == "" {
			var sp models.OrderSplit
			if err := tx.Where("restaurant_id = ? AND order_id = ? AND account_id IS NOT NULL", rid, order.ID).
				Order("paid_at ASC").
				Limit(1).
				First(&sp).Error; err == nil && sp.AccountID != nil {
				accountID = *sp.AccountID
			}
		}
		if accountID == "" {
			return apperrors.Wrap("CONFLICT", "cannot determine source account for refund", nil)
		}

		opType := "out"
		opCat := "refund"
		opActivity := "operational"
		opDate := now.Format("2006-01-02")
		opDesc := fmt.Sprintf("%s%d: %s", refundOpDescPrefix, order.OrderNumber, reason)
		opAuto := true
		opSourceRef := fmt.Sprintf("order_refund:%s:%d", order.ID, now.UnixNano())
		finOp := &models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         &opType,
			Amount:       amount,
			Category:     &opCat,
			Activity:     &opActivity,
			AccountID:    &accountID,
			Date:         &opDate,
			Description:  &opDesc,
			IsAuto:       &opAuto,
			SourceRef:    &opSourceRef,
			RestaurantID: &rid,
			ShiftID:      order.ShiftID,
			CreatedBy:    actorIDPtr(ctx),
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(finOp).Error; err != nil {
			return err
		}
		// Debit account balance (мы снимаем деньги — balance уменьшается).
		// Model(&FinancialAccount{ID: ...}), не голый литерал: ADR-003 Ф5 —
		// generic trackedSave-хук достаёт RowID через reflection.
		if err := tx.Model(&models.FinancialAccount{ID: accountID}).
			Where("restaurant_id = ?", rid).
			Updates(map[string]any{
				"balance":    gorm.Expr("balance - ?", amount),
				"updated_at": now,
			}).Error; err != nil {
			return err
		}

		// Если возврат наличными со счёта открытой смены — зеркалим в кассовую
		// смену (cash_out), иначе expected_cash в Z-отчёте не сойдётся с ящиком
		// (ложная недостача). No-op для безнала/без активной смены.
		if err := recordShiftCashOutIfActive(tx, rid, "", accountID, opDesc, opDate, finOp.ID, amount, now); err != nil {
			return err
		}
		// Кухонный чек «ОТМЕНА» на возврат (запрос владельца): как при отмене
		// заказа кухня должна узнать, что блюда вернули. enqueueCancelRunners
		// печатает только то, что кухня реально видела (printed_at), и НЕ трогает
		// склад/выручку — деньги уже вернула проводка выше. Только на первый
		// возврат, чтобы повторные частичные не дублировали чек.
		if firstRefund {
			var items []models.OrderItem
			if err := tx.Where("order_id = ? AND cancelled_at IS NULL", order.ID).
				Order("created_at ASC").Find(&items).Error; err != nil {
				return err
			}
			if err := s.enqueueCancelRunners(tx, rid, &order, items, "Возврат: "+reason, now); err != nil {
				return err
			}
		}
		refunded = amount
		buf.Add(EventOrderUpdated, map[string]any{
			"id":             order.ID,
			"refunded_total": newRefundedTotal.String(),
			"status":         deref(order.Status),
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	s.publish(ctx, rid, buf)
	return &RefundResult{OrderID: orderID, Refunded: refunded}, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// ReprintReceipt — повторная печать чека из истории.
// ═══════════════════════════════════════════════════════════════════════════

// ReprintReceipt — POST /api/v1/orders/{id}/reprint-receipt.
// Создаёт новый PrintJob type='receipt' с пометкой «КОПИЯ» в layout.
func (s *OrdersService) ReprintReceipt(ctx context.Context, orderID string) (*PrintZResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}

	var jobID string
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		var order models.Order
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, orderID).
			First(&order).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}

		// Грузим items.
		var items []models.OrderItem
		if err := tx.Where("order_id = ? AND cancelled_at IS NULL", order.ID).
			Order("created_at ASC").
			Find(&items).Error; err != nil {
			return err
		}
		if len(items) == 0 {
			return apperrors.Wrap("CONFLICT", "no items to reprint", nil)
		}

		var rest models.Restaurant
		if err := tx.Where("id = ?", rid).First(&rest).Error; err != nil {
			return err
		}

		pm := ""
		if order.PaymentMethod != nil {
			pm = *order.PaymentMethod
		}
		closedAt := time.Now().UTC()
		if order.ClosedAt != nil {
			closedAt = *order.ClosedAt
		}

		in := escpos.ReceiptInput{
			RestaurantName:  rest.Name,
			FastFood:        isFastFood(rest),
			OrderNumber:     order.OrderNumber,
			OpenedAt:        order.CreatedAt,
			ClosedAt:        closedAt,
			PaymentMethod:   pm,
			Subtotal:        order.Total,
			DiscountAmount:  order.DiscountAmount,
			ServiceAmount:   order.ServiceAmount,
			TipAmount:       order.TipAmount,
			Total:           order.TotalWithService,
			IsReprint:       true,
			DeliveryPhone:   strOrEmpty(order.DeliveryPhone),
			DeliveryAddress: strOrEmpty(order.DeliveryAddress),
		}
		if rest.Address != nil {
			in.RestaurantAddr = *rest.Address
		}
		for _, it := range items {
			ri := escpos.ReceiptItem{
				Qty:       it.Qty,
				Price:     it.Price,
				LineTotal: decimal.Normalize(decimal.Mul(it.Price, effectivePortions(it.Unit, it.Qty, it.UnitSize))),
			}
			if it.Name != nil {
				ri.Name = *it.Name
			}
			if it.Note != nil {
				ri.Note = *it.Note
			}
			if it.BundleGroupID != nil {
				ri.BundleGroupID = *it.BundleGroupID
			}
			if it.BundleSlotLabel != nil {
				ri.BundleSlotLabel = *it.BundleSlotLabel
			}
			in.Items = append(in.Items, ri)
		}
		// Настройки принтера — те же, что при оплате. Без этого перепечатка
		// шла с дефолтной кодовой страницей: чек при оплате печатался верно,
		// а он же из закрытых заказов — абракадаброй.
		if rp, ok := receiptPrinterFor(tx, rid); ok {
			applyPrinterToReceipt(&in, rp)
		}
		payload := escpos.ReceiptLayout(in)

		now := time.Now().UTC()
		pj := &models.PrintJob{
			ID:           uuid.NewString(),
			Type:         "receipt",
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
		jobID = pj.ID
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &PrintZResult{JobID: jobID, Status: "pending"}, nil
}

// ─── helpers ───────────────────────────────────────────────────────────────

func deref(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// derefOr разыменовывает p, а при nil/пустом — возвращает fallback.
func derefOr(p *string, fallback string) string {
	if p != nil && *p != "" {
		return *p
	}
	return fallback
}

// jsonUnmarshal — мини-обёртка вокруг encoding/json чтобы не таскать import
// в файл, который и так уже большой по логике. Берём datatypes.JSON ([]byte).
func jsonUnmarshal(b []byte, out any) error {
	if len(b) == 0 {
		return nil
	}
	return jsonStdPkg.Unmarshal(b, out)
}
