package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ReceiptPayInput — body POST /api/v1/stock/receipts/{id}/pay.
type ReceiptPayInput struct {
	Amount    string `json:"amount"`
	AccountID string `json:"account_id"`
}

// PayReceipt — оплата долга по КОНКРЕТНОЙ накладной. В отличие от
// SuppliersService.PayDebt (гасит долг поставщику FIFO по всем его накладным),
// здесь платёж адресован именно этой накладной — это ровно то, что ждёт
// пользователь, нажав «Оплатить» в её строке.
//
// Атомарно: списывает pay со счёта, на накладной debt_amount −pay и
// paid_amount +pay (paid_amount ведём точно — колонка «Оплачено» становится
// верной, FIFO-раскладка PayDebt её не трогает), у поставщика current_debt
// −pay, и создаёт financial_operation out category='supplier_payment'. Это
// гашение обязательства, а НЕ операционный расход (расход признан как COGS при
// продаже товара), поэтому категория исключена из opex ОПиУ.
//
// Сумма клампится к остатку долга накладной — переплатить нельзя. Инвариант
// Σ receipt.debt_amount = supplier.current_debt сохраняется: и накладная, и
// поставщик уменьшаются на одну и ту же pay.
func (s *StockService) PayReceipt(ctx context.Context, id string, in ReceiptPayInput) (*models.StockReceipt, error) {
	// Оплата долга тратит деньги со счёта. Кладовщик ведёт накладные
	// (inventory.manage), бухгалтер — деньги (finance.manage); достаточно любого.
	if !hasPermFor(ctx, s.r, "inventory.manage") && !hasPermFor(ctx, s.r, "finance.manage") {
		return nil, apperrors.Wrap("FORBIDDEN", "недостаточно прав для оплаты накладной", nil)
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	amount, err := decimal.FromString(in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be > 0", err)
	}
	if in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "account_id is required", nil)
	}
	if err := MustBeEnabled(ctx, s.r, in.AccountID); err != nil {
		return nil, err
	}
	now := time.Now().UTC()

	var out *models.StockReceipt
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Канонический порядок замков (см. orders_perms.go): поставщик → накладная
		// → счёт. Поставщика узнаём из накладной БЕЗ замка (только supplier_id),
		// затем берём замки в порядке — иначе AB-BA с возвратом и PayDebt.
		var peek models.StockReceipt
		if err := tx.Select("id", "supplier_id").
			Where("restaurant_id = ? AND id = ?", rid, id).First(&peek).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		var sup *models.Supplier
		if peek.SupplierID != nil && *peek.SupplierID != "" {
			var sp models.Supplier
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, *peek.SupplierID).First(&sp).Error; err != nil {
				return apperrors.Wrap("VALIDATION", "supplier not found", err)
			}
			sup = &sp
		}

		var receipt models.StockReceipt
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, id).First(&receipt).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if !decimal.IsPositive(receipt.DebtAmount) {
			return apperrors.Wrap("CONFLICT", "по накладной нет долга", nil)
		}
		pay := amount
		if pay.GreaterThan(receipt.DebtAmount) {
			pay = receipt.DebtAmount // не переплачиваем долг накладной
		}

		var acc models.FinancialAccount
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, in.AccountID).First(&acc).Error; err != nil {
			return apperrors.Wrap("VALIDATION", "account not found", err)
		}
		newBal := decimal.Normalize(decimal.Sub(acc.Balance, pay))
		if decimal.IsNegative(newBal) {
			return apperrors.Wrap("CONFLICT", "insufficient funds on account", nil)
		}
		if err := tx.Model(&acc).Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
			return err
		}

		// Накладная: долг −pay, оплачено +pay. payment_type пересчитываем: долг в
		// ноль → paid, иначе → partial (сюда попадаем только при debt>0).
		receipt.DebtAmount = decimal.Normalize(decimal.Sub(receipt.DebtAmount, pay))
		receipt.PaidAmount = decimal.Normalize(decimal.Add(receipt.PaidAmount, pay))
		payType := "partial"
		if !decimal.IsPositive(receipt.DebtAmount) {
			payType = "paid"
		}
		if err := tx.Model(&receipt).Updates(map[string]any{
			"debt_amount":  receipt.DebtAmount,
			"paid_amount":  receipt.PaidAmount,
			"payment_type": payType,
			"updated_at":   now,
		}).Error; err != nil {
			return err
		}
		receipt.PaymentType = &payType

		// Поставщик: current_debt −pay, но не ниже нуля. current_debt денормализован
		// и мог разойтись (восстановление из бэкапа, дрейф) — уехать в минус нельзя,
		// RecomputeDebts потом вычистит.
		if sup != nil {
			nd := decimal.Sub(sup.CurrentDebt, pay)
			if decimal.IsNegative(nd) {
				nd = decimal.Zero
			}
			if err := tx.Model(sup).Updates(map[string]any{
				"current_debt": decimal.Normalize(nd),
				"updated_at":   now,
			}).Error; err != nil {
				return err
			}
			if err := recordSupplierSync(tx, []string{sup.ID}); err != nil {
				return err
			}
		}

		opType := "out"
		opCat := "supplier_payment"
		opActivity := "operational"
		opDate := now.Format("2006-01-02")
		isAuto := true
		desc := "Оплата накладной"
		if receipt.SupplierName != nil && *receipt.SupplierName != "" {
			desc = "Оплата накладной: " + *receipt.SupplierName
		}
		accID := in.AccountID
		ridStr := rid
		fo := &models.FinancialOperation{
			ID: uuid.NewString(), Type: &opType, Amount: pay, Category: &opCat,
			AccountID: &accID, AccountName: acc.Name, Activity: &opActivity, Date: &opDate,
			Description: &desc, Counterparty: receipt.SupplierName, IsAuto: &isAuto,
			// SourceRef = supplier.id — платёж привязан к поставщику по ID
			// (переименование не теряет историю платежей на его карточке).
			SourceRef:    receipt.SupplierID,
			RestaurantID: &ridStr, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(fo).Error; err != nil {
			return err
		}
		if err := recordReceiptSync(tx, []string{receipt.ID}); err != nil {
			return err
		}
		out = &receipt
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}
