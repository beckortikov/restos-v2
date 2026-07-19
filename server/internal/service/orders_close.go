package service

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/escpos"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/pkg/units"
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

	// ApprovedBy — UUID менеджера/owner, одобрившего скидку ≥10%.
	// Без него скидка >10% (или fixed-эквивалент >10% от subtotal) отклоняется
	// с 403 DISCOUNT_REQUIRES_APPROVAL. Логируется в order.discount_approved_by.
	ApprovedBy *string `json:"approved_by,omitempty"`

	// ServicePercent — % обслуживания, выбранный кассиром в момент close.
	// Если nil — берём order.ServicePercent (default ресторана). Если "0"
	// — сервис отключён для этого заказа. Хранится в order.service_percent
	// и используется при вычислении total_with_service.
	ServicePercent *string `json:"service_percent,omitempty"`

	// SkipReceipt — если true, чек не enqueue'ится в print_jobs. Кассир выбрал
	// «Закрыть без печати» в sidebar'е. Заказ всё равно закрывается + revenue
	// fix'ится. Полезно когда принтер недоступен или клиенту не нужен чек.
	SkipReceipt bool `json:"skip_receipt,omitempty"`
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
	// Enum-валидация payment_method для single-payment. Multi-payment проверяет
	// каждую entry отдельно ниже. Whitelist синхронен с payments[].method.
	if len(in.Payments) == 0 {
		switch in.PaymentMethod {
		case "cash", "card", "transfer":
			// ok
		default:
			return nil, nil, apperrors.Wrap("VALIDATION", "payment_method must be cash|card|transfer", nil)
		}
	}
	tip := decimal.Zero
	if in.TipAmount != "" {
		tip, err = decimal.FromString(in.TipAmount)
		if err != nil {
			return nil, nil, apperrors.Wrap("VALIDATION", "bad tip_amount", err)
		}
		// Отрицательные чаевые занижали total_with_service (а с ним и требуемую
		// Σ payments) — работали как невалидируемая скидка в обход approval-гейта.
		if decimal.IsNegative(tip) {
			return nil, nil, apperrors.Wrap("VALIDATION", "tip_amount must be >= 0", nil)
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

		// 2. Validate shift ПОД FOR UPDATE. Ниже read-modify-write агрегатов смены
		// (CashRevenue/CardRevenue/OrdersCount) через tx.Save — без замка два
		// параллельных close РАЗНЫХ заказов одной смены читают одинаковый
		// CashRevenue, второй Save затирает первый (lost update) → заниженный
		// expected_cash → ложная недостача кассира. PaySplit/reverse смену уже
		// блокируют — здесь забыли (#1).
		var shift models.CashShift
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, in.ShiftID).
			First(&shift).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "shift not found", nil)
			}
			return err
		}
		if shift.Status == nil || *shift.Status != "open" {
			return apperrors.Wrap("CONFLICT", "shift is not open", nil)
		}

		// #2: нельзя оплатить «весь счёт» поверх созданных сплитов — иначе выручка
		// задваивается (order-level revenue + split-платежи на ту же сумму).
		// Разделённый заказ оплачивается только через /splits/{id}/pay; чтобы
		// закрыть целиком — сперва отменить разделение (CancelSplits удаляет строки).
		var splitCount int64
		if err := tx.Model(&models.OrderSplit{}).
			Where("order_id = ?", order.ID).Count(&splitCount).Error; err != nil {
			return err
		}
		if splitCount > 0 {
			return apperrors.Wrap("CONFLICT", "заказ разделён на счета — оплатите по частям или отмените разделение", nil)
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

			// БАГ #1 — backend approval-gate для скидок ≥10%.
			// Вычисляем эффективный процент: для percent — discountValue,
			// для fixed — (discountAmount / order.Total) * 100. Если subtotal=0
			// — гейт пропускаем (вырожденный case).
			effectivePct := decimal.Zero
			if *in.DiscountType == "percent" {
				effectivePct = discountValue
			} else if !order.Total.IsZero() {
				effectivePct = decimal.Mul(
					decimal.DivRound(discountAmount, order.Total),
					decimal.FromInt(100),
				)
			}
			if effectivePct.GreaterThan(decimal.FromInt(10)) {
				if in.ApprovedBy == nil || *in.ApprovedBy == "" {
					return apperrors.Wrap(
						"DISCOUNT_REQUIRES_APPROVAL",
						"discount ≥10% requires approved_by (manager/owner)",
						nil,
					)
				}
				// Проверяем что approver — действующий manager/owner ресторана.
				var approver models.User
				if err := tx.Where("restaurant_id = ? AND id = ?", rid, *in.ApprovedBy).
					First(&approver).Error; err != nil {
					if errors.Is(err, gorm.ErrRecordNotFound) {
						return apperrors.Wrap(
							"DISCOUNT_REQUIRES_APPROVAL",
							"approved_by user not found",
							nil,
						)
					}
					return err
				}
				if approver.Role == nil || (*approver.Role != "manager" && *approver.Role != "owner") {
					return apperrors.Wrap(
						"DISCOUNT_REQUIRES_APPROVAL",
						"approved_by must be manager or owner",
						nil,
					)
				}
				ab := approver.ID
				order.DiscountApprovedBy = &ab
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
		// Обслуживание — только для зала. «С собой» (takeaway) и доставка
		// не облагаются, даже если в input прилетел ненулевой процент.
		if order.Type != nil && *order.Type != "hall" {
			servicePercent = decimal.Zero
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

		// Идемпотентность выручки (ретрай/гонка двойного close): если по
		// заказу уже есть revenue-FO — НЕ постим выручку/кредит счёта/агрегаты
		// смены повторно. Склад ниже уже идемпотентен по тому же source_ref.
		// Reopen сторнирует revenue-FO (reverseCloseFinancials), поэтому
		// reopen→reclose сюда попадает с alreadyPosted=false и постит
		// выручку заново — уже по новой сумме.
		var revExisting int64
		if err := tx.Model(&models.FinancialOperation{}).
			Where("restaurant_id = ? AND source_ref = ? AND category = ?", rid, opSourceRef, opCat).
			Count(&revExisting).Error; err != nil {
			return err
		}
		alreadyPosted := revExisting > 0

		if !alreadyPosted {
			// Валидируем СУЩЕСТВОВАНИЕ счетов ДО кредита: creditAccount ниже — это
			// UPDATE ... WHERE id=?, при несуществующем/пустом id молча меняет 0
			// строк → revenue-FO создаётся, а баланс «Кассы» не растёт (расхождение
			// ДДС↔Касса). Теперь несуществующий счёт → явная ошибка.
			var accIDs []string
			if isMulti {
				for _, p := range in.Payments {
					accIDs = append(accIDs, p.AccountID)
				}
			} else {
				if in.AccountID == "" {
					return apperrors.Wrap("VALIDATION", "account_id is required to post revenue", nil)
				}
				accIDs = append(accIDs, in.AccountID)
			}
			for _, aid := range accIDs {
				var cnt int64
				if err := tx.Model(&models.FinancialAccount{}).
					Where("restaurant_id = ? AND id = ?", rid, aid).
					Count(&cnt).Error; err != nil {
					return err
				}
				if cnt == 0 {
					return apperrors.Wrap("VALIDATION", "financial account not found: "+aid, nil)
				}
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

			// 6. Stock deduct через tech_card_lines. Идемпотентность (per-item)
			// живёт внутри deductStockForOrder — повторный close/reopen списывает
			// только ещё не списанные позиции (#5/#6).
			if err := s.deductStockForOrder(tx, rid, &order, opSourceRef, now); err != nil {
				return err
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
		} // end if !alreadyPosted — выручка/кредит/склад/агрегаты постятся ОДИН раз

		// 8. Enqueue receipt print job (fire-and-forget: worker отправит после commit).
		//    SkipReceipt — кассир явно выбрал «Закрыть без печати» в sidebar'е;
		//    job не создаём, перепечатка из истории остаётся доступной.
		receiptPM := ""
		if order.PaymentMethod != nil {
			receiptPM = *order.PaymentMethod
		}
		if !in.SkipReceipt {
			if err := s.enqueueReceipt(tx, rid, &order, receiptPM, now); err != nil {
				// Не валим транзакцию из-за печати — клиент может перепечатать
				// вручную. Но раньше ошибку проглатывали (_ = err) и провал
				// постановки чека в очередь было невозможно диагностировать.
				log.Warn().Err(err).Str("order_id", order.ID).
					Msg("close_order: enqueue receipt failed (order closed anyway)")
			}
		}

		// 8b. Фастфуд (restaurants.kitchen_on_pay): кухня узнаёт о заказе только
		//     сейчас — после оплаты. Бегунки при создании/дозаказе пропущены
		//     (orders_write), ставим их здесь: гость платит → чек с номером ему,
		//     бегунок с тем же order_number на кухню.
		//     Печатаем только ненапечатанное — enqueueRunners сам считает
		//     qty - qty_printed, поэтому повторный close не задвоит.
		//     Ошибку НЕ проглатываем (в отличие от чека): без бегунка заказ был бы
		//     оплачен, но не приготовлен — лучше откатить и дать повторить.
		if s.kitchenOnPay(tx, rid) {
			var kitchenItems []models.OrderItem
			if err := tx.Where("order_id = ?", order.ID).Find(&kitchenItems).Error; err != nil {
				return err
			}
			if err := s.enqueueRunners(tx, rid, &order, kitchenItems, now); err != nil {
				return err
			}
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
						"waiter_id":        nil,
						"opened_at":        nil,
						"updated_at":       now,
					}).Error; err != nil {
					return err
				}
				buf.Add(EventTableUpdated, map[string]any{"id": *order.TableID})
			} else {
				// Переключаем current_order_id на следующий старейший активный заказ этого стола
				var nextActive models.Order
				if err := tx.Where("restaurant_id = ? AND table_id = ?", rid, *order.TableID).
					Where("status IN ?", []string{"new", "open", "cooking", "ready", "served", "bill_requested"}).
					Where("id <> ?", order.ID).
					Order("created_at ASC").
					First(&nextActive).Error; err == nil {
					if err := tx.Model(&models.Table{}).
						Where("id = ? AND restaurant_id = ?", *order.TableID, rid).
						Updates(map[string]any{
							"current_order_id": nextActive.ID,
							"waiter_id":        nextActive.WaiterID,
							"updated_at":       now,
						}).Error; err != nil {
						return err
					}
					buf.Add(EventTableUpdated, map[string]any{"id": *order.TableID})
				}
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
	// Заготовочные блюда (is_batch_cooking) списываются из ГОТОВОЙ партии
	// (prepared_qty), а НЕ повторно по сырью — ингредиенты уже ушли на produce.
	var menus []models.MenuItem
	if err := tx.Where("restaurant_id = ? AND id IN ?", restaurantID, menuIDs).
		Find(&menus).Error; err != nil {
		return err
	}
	isBatch := make(map[string]bool, len(menus))
	for _, m := range menus {
		if m.IsBatchCooking != nil && *m.IsBatchCooking {
			isBatch[m.ID] = true
		}
	}

	var lines []models.TechCardLine
	if err := tx.Where("restaurant_id = ? AND menu_item_id IN ?", restaurantID, menuIDs).
		Find(&lines).Error; err != nil {
		return err
	}
	linesByMenu := make(map[string][]models.TechCardLine)
	baseIngIDs := make([]string, 0, len(lines))
	for _, l := range lines {
		if l.MenuItemID == nil {
			continue
		}
		linesByMenu[*l.MenuItemID] = append(linesByMenu[*l.MenuItemID], l)
		if l.IngredientID != nil && *l.IngredientID != "" {
			baseIngIDs = append(baseIngIDs, *l.IngredientID)
		}
	}
	// Складские единицы + per-unit факторы базовых ингредиентов — списание пишем
	// в единице склада (тех-карта в г/мл → шт/кг). Semi-ингредиенты грузятся в
	// cascadeSemiDeduct отдельно.
	convByID, err := loadIngStockConv(tx, baseIngIDs)
	if err != nil {
		return err
	}

	// #5/#6: per-item идемпотентность. Раньше было «есть любое движение заказа →
	// пропустить ВСЁ»: reopen+добавить позицию+reclose не списывал новую позицию,
	// а batch-заготовка (движений не пишет) списывалась повторно. Теперь метим
	// каждое движение позиции суффиксом ":<item_id>" и пропускаем только уже
	// списанные позиции; batch пишет маркер-движение ради той же идемпотентности.
	deductedItems := make(map[string]bool)
	{
		var descs []string
		if err := tx.Model(&models.StockMovement{}).
			Where("restaurant_id = ? AND description LIKE ?", restaurantID, sourceRef+"%").
			Distinct("description").Pluck("description", &descs).Error; err != nil {
			return err
		}
		for _, d := range descs {
			if d == sourceRef {
				// Заказ закрыт ДО перехода на per-item (старый формат «order:{id}» без
				// суффикса) — сохраняем прежнюю семантику «весь заказ уже списан».
				return nil
			}
			if strings.HasPrefix(d, sourceRef+":") {
				deductedItems[strings.TrimPrefix(d, sourceRef+":")] = true
			}
		}
	}

	// 3. Для каждой позиции × tech_card_line — создаём StockMovement (qty<0 = списание).
	//    v2.0.90 — semi-finished каскадно разворачиваются до базовых ингредиентов
	//    через semi_recipe_lines (см. MISSING #4).
	for _, it := range items {
		if it.MenuItemID == nil {
			continue
		}
		if deductedItems[it.ID] {
			continue // позиция уже списана при прошлом закрытии
		}
		itemRef := sourceRef + ":" + it.ID

		// Заготовка: уменьшаем prepared_qty на число порций (cap на 0), сырьё
		// НЕ списываем (иначе двойное списание). Идемпотентность обеспечена
		// guard'ом «order already closed» в Close/CheckAndClose/PaySplit.
		if isBatch[*it.MenuItemID] {
			portions := decimal.Normalize(it.Qty).IntPart()
			if portions <= 0 {
				continue
			}
			if err := tx.Model(&models.MenuItem{}).
				Where("restaurant_id = ? AND id = ?", restaurantID, *it.MenuItemID).
				Updates(map[string]any{
					"prepared_qty": gorm.Expr("GREATEST(COALESCE(prepared_qty, 0) - ?, 0)", portions),
					"updated_at":   now,
				}).Error; err != nil {
				return err
			}
			// Маркер-движение (qty=0, без ingredient_id — денорм-хук его пропустит):
			// нужен, чтобы reopen+reclose не списал prepared_qty второй раз (#6).
			mType := "batch_sale"
			if err := tx.Create(&models.StockMovement{
				ID: uuid.NewString(), Type: &mType, Description: &itemRef,
				Qty: decimal.Zero, RestaurantID: &restaurantID, CreatedAt: now,
			}).Error; err != nil {
				return err
			}
			continue
		}

		tcl := linesByMenu[*it.MenuItemID]
		for _, line := range tcl {
			lineQty := decimal.Mul(line.Qty, effectivePortions(it.Unit, it.Qty, it.UnitSize))
			switch {
			case line.IngredientID != nil:
				if err := writeIngredientDeduct(tx, restaurantID, *line.IngredientID, line.Name, convByID[*line.IngredientID], deref(line.Unit), lineQty, itemRef, now); err != nil {
					return err
				}
			case line.SemiTypeID != nil:
				// iiko-модель: сперва расходуем ГОТОВУЮ заготовку со склада, а
				// нехватку разузловываем в сырьё. Раньше всегда каскадили в сырьё
				// (cascadeSemiDeduct), игнорируя остаток заготовки, — из-за чего при
				// использовании предзаготовки (Prepare) сырьё списывалось дважды.
				// Package-level (не метод OrdersService) — используется и здесь, и
				// BatchCookingService.Produce (см. batch_cooking.go); itemRef (не
				// sourceRef) — per-item идемпотентность (#5/#6), как у ingredient-веток.
				if err := deductSemiForSale(tx, restaurantID, *line.SemiTypeID, lineQty, deref(line.Unit), itemRef, now); err != nil {
					return err
				}
			}
		}
	}
	return nil
}

// writeIngredientDeduct — append-only stock_movement type=out на базовый
// ингредиент. qty задаётся в РЕЦЕПТУРНОЙ единице recipeUnit; здесь она приводится
// к складской единице ингредиента (conv) перед записью — движение и денорм
// ingredients.qty (хук) должны быть в единице склада. Штучный склад с per-unit
// фактором (10 г ÷ 340 г/шт = 0.0294 шт) обрабатывается тем же путём.
func writeIngredientDeduct(
	tx *gorm.DB,
	restaurantID, ingredientID string,
	name *string,
	conv ingStockConv,
	recipeUnit string,
	qty decimal.Decimal,
	sourceRef string,
	now time.Time,
) error {
	// #20: несводимые единицы без фактора веса (тех-карта «200 г» при складе
	// «шт», unit_weight не задан) — ConvertToStock молча вернул бы 200 и списал
	// «200 штук» за порцию. Это мисконфигурация тех-карты: не списываем дикое
	// число (пропускаем строку, лог), вместо того чтобы обнулить склад.
	if !conv.convertible(recipeUnit) {
		log.Warn().Str("ingredient", ingredientID).Str("recipe_unit", recipeUnit).
			Str("stock_unit", conv.unit).Msg("tech-card unit not convertible to stock unit — skipping deduction")
		return nil
	}
	// #18: списываем БРУТТО — с учётом отходов при очистке (waste_percent), ровно
	// как COGS считает qty/(1−waste). Раньше waste был в COGS и в проверке
	// остатка, но не в фактическом списании → склад копил фантомный остаток, за
	// который COGS уже «заплатил» (всплывало недостачей при инвентаризации).
	if conv.wastePercent.IsPositive() {
		divisor := decimal.Sub(decimal.FromInt(1), decimal.DivRound(conv.wastePercent, decimal.FromInt(100)))
		if divisor.IsPositive() {
			qty = decimal.DivRound(qty, divisor)
		}
	}
	stockQty := conv.toStock(qty, recipeUnit)
	deduct := decimal.Normalize(stockQty).Neg()
	desc := sourceRef
	opType := "out"
	ingID := ingredientID
	// Единица движения — складская; если у ингредиента она не задана, оставляем
	// рецептурную (фолбэк, поведение как раньше).
	unit := conv.unit
	unitPtr := &unit
	if unit == "" {
		ru := recipeUnit
		unitPtr = &ru
	}
	mv := &models.StockMovement{
		ID:             uuid.NewString(),
		Type:           &opType,
		IngredientID:   &ingID,
		IngredientName: name,
		Description:    &desc,
		Qty:            deduct,
		Unit:           unitPtr,
		RestaurantID:   &restaurantID,
		CreatedAt:      now,
	}
	return tx.Create(mv).Error
}

// cascadeSemiDeduct рекурсивно разворачивает полуфабрикат до базовых
// ингредиентов через semi_recipe_lines.
//
// qty — сколько единиц полуфабриката нужно (после применения yield_percent
// мы делим на yield/100, чтобы получить сырьё «до уварки»).
//
// depth — текущая глубина (защита от циклов: max 5).
// deductSemiForSale — списание заготовки при продаже по модели iiko: сперва
// расходуем ГОТОВЫЙ остаток semi_finished_stock (сырьё для него уже списано в
// Prepare), а нехватку разузловываем в базовые ингредиенты (cascadeSemiDeduct,
// «на лету»). Раньше при продаже ВСЕГДА каскадили в сырьё, игнорируя остаток
// заготовки, — при использовании предзаготовки сырьё уходило дважды (баг C1).
//
// lineQty — потребность в единице тех-карты блюда (lineUnit); приводим к единице
// заготовки. yield_percent при расходе готовой заготовки НЕ применяется (он уже
// учтён при производстве); cascadeSemiDeduct применит его только к остатку-нехватке.
//
// Package-level (не метод OrdersService) — используется и при продаже заказом
// (deductStockForOrder), и при партионной готовке (BatchCookingService.Produce):
// оба сценария обязаны списывать полуфабрикат из тех-карты одинаково.
func deductSemiForSale(
	tx *gorm.DB,
	restaurantID, semiTypeID string,
	lineQty decimal.Decimal,
	lineUnit, sourceRef string,
	now time.Time,
) error {
	var sft models.SemiFinishedType
	if err := tx.Where("restaurant_id = ? AND id = ?", restaurantID, semiTypeID).
		First(&sft).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil // заготовка не настроена — не блокируем закрытие
		}
		return err
	}
	needed := units.Convert(lineQty, lineUnit, deref(sft.OutputUnit))
	if !decimal.IsPositive(needed) {
		return nil
	}

	// Готовый остаток заготовки (с блокировкой строки от гонок параллельных продаж).
	var stock models.SemiFinishedStock
	err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("restaurant_id = ? AND semi_type_id = ?", restaurantID, semiTypeID).
		First(&stock).Error
	hasStock := err == nil
	if err != nil && !errors.Is(err, gorm.ErrRecordNotFound) {
		return err
	}

	fromStock := decimal.Zero
	if hasStock && decimal.IsPositive(stock.Qty) {
		if stock.Qty.GreaterThanOrEqual(needed) {
			fromStock = needed
		} else {
			fromStock = stock.Qty // частичная нехватка — берём сколько есть
		}
	}

	// 1. Расход готовой заготовки со склада (сырьё уже списано при Prepare).
	if decimal.IsPositive(fromStock) {
		stock.Qty = decimal.Normalize(decimal.Sub(stock.Qty, fromStock))
		stock.UpdatedAt = now
		if err := tx.Save(&stock).Error; err != nil {
			return err
		}
		// Маркер-движение (semi_out, без ингредиента — хук денорма его пропускает):
		// 1) идемпотентность close считает движения по description=order:{id} —
		//    без маркера блюдо ТОЛЬКО из заготовки не оставляло следа и могло
		//    списаться повторно при reopen→reclose; 2) аудит расхода п/ф.
		mvType := "semi_out"
		desc := sourceRef
		u := deref(sft.OutputUnit)
		mv := &models.StockMovement{
			ID:             uuid.NewString(),
			Type:           &mvType,
			Description:    &desc,
			IngredientName: sft.Name,
			Qty:            decimal.Normalize(fromStock).Neg(),
			Unit:           &u,
			RestaurantID:   &restaurantID,
			CreatedAt:      now,
		}
		if err := tx.Create(mv).Error; err != nil {
			return err
		}
	}

	// 2. Нехватку разузловываем в сырьё (модель «на лету»); cascadeSemiDeduct сам
	//    применит yield_percent к этому остатку.
	if remainder := decimal.Sub(needed, fromStock); decimal.IsPositive(remainder) {
		if err := cascadeSemiDeduct(tx, restaurantID, semiTypeID, remainder, sourceRef, now, 0); err != nil {
			return err
		}
	}
	return nil
}

func cascadeSemiDeduct(
	tx *gorm.DB,
	restaurantID, semiTypeID string,
	qty decimal.Decimal,
	sourceRef string,
	now time.Time,
	depth int,
) error {
	if depth >= 5 {
		return apperrors.Wrap("INTERNAL", "tech-card cycle or too-deep semi-finished recipe (>5)", nil)
	}
	// Yield-percent: если semi_finished_types.yield_percent=80, нужно
	// добавить 25% сырья (qty / 0.8). Default 100 → без изменений.
	var sft models.SemiFinishedType
	if err := tx.Where("restaurant_id = ? AND id = ?", restaurantID, semiTypeID).
		First(&sft).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			// Полуфабрикат не настроен — пропускаем (без ошибки, чтобы не
			// блокировать close при неполной настройке меню).
			return nil
		}
		return err
	}
	rawQty := qty
	if sft.YieldPercent.IsPositive() {
		hundred := decimal.FromInt(100)
		if !sft.YieldPercent.Equal(hundred) {
			rawQty = decimal.Mul(qty, decimal.DivRound(hundred, sft.YieldPercent))
		}
	}

	var lines []models.SemiRecipeLine
	if err := tx.Where("semi_type_id = ?", semiTypeID).Find(&lines).Error; err != nil {
		return err
	}
	semiIngIDs := make([]string, 0, len(lines))
	for _, l := range lines {
		if l.IngredientID != nil && *l.IngredientID != "" {
			semiIngIDs = append(semiIngIDs, *l.IngredientID)
		}
	}
	convByID, err := loadIngStockConv(tx, semiIngIDs)
	if err != nil {
		return err
	}
	for _, l := range lines {
		needed := decimal.Mul(l.QtyPerUnit, rawQty)
		switch {
		case l.IngredientID != nil:
			if err := writeIngredientDeduct(tx, restaurantID, *l.IngredientID, l.Name, convByID[*l.IngredientID], deref(l.Unit), needed, sourceRef, now); err != nil {
				return err
			}
		default:
			// Nested semi-finished не моделируется semi_recipe_lines.SemiTypeID,
			// но мы предусмотрим — если расширим схему, дополним здесь.
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

	// 2a. Конфиг default receipt-принтера (cols + content flags из миграции 015).
	// Если не настроен — заказ всё равно закрываем (close_order не должен падать),
	// просто кладём job без printer_id и worker сам резолвит / помечает failed.
	var receiptP models.Printer
	// Дефолтный чековый принтер, иначе единственный включённый (is_default DESC).
	hasReceiptP := tx.Where("restaurant_id = ? AND kind = 'receipt' AND enabled = TRUE", restaurantID).
		Order("is_default DESC, created_at ASC").First(&receiptP).Error == nil

	// 2b. Догружаем стол/зону/официанта/кассира — без них чек шёл без шапки
	// "Стол / Официант / Кассир" (баг v2.0.99).
	meta := loadOrderPrintMeta(tx, order, true)
	tableLabel := joinNonEmpty(" · ", meta.ZoneName, meta.TableLabel)
	// Для takeaway/delivery: подставляем тип, если зоны нет (как в v1 receipt).
	if tableLabel == "" {
		if order.Type != nil && *order.Type != "hall" {
			tableLabel = orderTypeLabel(order)
		}
	}

	// 3. Готовим input layout.
	in := escpos.ReceiptInput{
		RestaurantName: rest.Name,
		FastFood:       isFastFood(rest),
		OrderNumber:    order.OrderNumber,
		OpenedAt:       order.CreatedAt,
		ClosedAt:       now,
		PaymentMethod:  paymentMethod,
		Subtotal:       order.Total,
		DiscountAmount: order.DiscountAmount,
		ServiceAmount:  order.ServiceAmount,
		TipAmount:      order.TipAmount,
		Total:          order.TotalWithService,
		TableLabel:     tableLabel,
		WaiterName:     meta.WaiterName,
		CashierName:    meta.CashierName,
		GuestsCount:    meta.GuestsCount,
	}
	if hasReceiptP {
		in.Cols = receiptP.Cols
		in.SuppressLogo = !receiptP.PrintLogo
		in.SuppressDiscount = !receiptP.PrintDiscount
		in.SuppressService = !receiptP.PrintService
		in.ShowTip = receiptP.PrintTip
		in.ShowQRFeedback = receiptP.PrintQRFeedback
	}
	if rest.Address != nil {
		in.RestaurantAddr = *rest.Address
	}
	for _, g := range groupPrintItems(items) {
		in.Items = append(in.Items, escpos.ReceiptItem{
			Name:      g.Name,
			Qty:       g.Qty,
			Price:     g.Price,
			LineTotal: g.LineTotal,
			Note:      g.Note,
			Unit:      g.Unit,
			Count:     g.Count,
		})
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
	if hasReceiptP {
		pid := receiptP.ID
		pj.PrinterID = &pid
	}
	// SkipHooks: print_jobs не пишем в audit.
	return tx.Session(&gorm.Session{SkipHooks: true}).Create(pj).Error
}
