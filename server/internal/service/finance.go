// finance — Phase 12 backend gap C: финансовые счета, операции, кастомные категории,
// JSON-отчёты (P&L, cashflow, balance, monthly revenue), выплаты ЗП и сервиса.
//
// Все мутации со связанными таблицами идут через repo.Transaction. Все запросы
// — через ForTenant(ctx). Decimal-поля принимаем как *string в DTO.
package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ═══════════════════════════════════════════════════════════════════════════
// FinancialAccount CRUD + transfer
// ═══════════════════════════════════════════════════════════════════════════

type FinancialAccountsService struct{ r *repo.Repo }

func NewFinancialAccountsService(r *repo.Repo) *FinancialAccountsService {
	return &FinancialAccountsService{r: r}
}

type FinancialAccountInput struct {
	Name    *string `json:"name,omitempty"`
	Type    *string `json:"type,omitempty"`
	Balance *string `json:"balance,omitempty"`
}

type AccountTransferInput struct {
	FromID      *string `json:"from_id,omitempty"`
	ToID        *string `json:"to_id,omitempty"`
	Amount      *string `json:"amount,omitempty"`
	Description *string `json:"description,omitempty"`
}

type AccountTransferResult struct {
	From models.FinancialOperation `json:"from"`
	To   models.FinancialOperation `json:"to"`
}

func (s *FinancialAccountsService) List(ctx context.Context) ([]models.FinancialAccount, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.FinancialAccount
	if err := scoped.Order("name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *FinancialAccountsService) Create(ctx context.Context, in FinancialAccountInput) (*models.FinancialAccount, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	a := &models.FinancialAccount{
		ID: uuid.NewString(), Name: in.Name, Type: in.Type,
		RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	if in.Balance != nil {
		d, err := decimal.FromString(*in.Balance)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad balance", err)
		}
		a.Balance = d
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(a).Error; err != nil {
		return nil, err
	}
	return a, nil
}

func (s *FinancialAccountsService) Patch(ctx context.Context, id string, in FinancialAccountInput) (*models.FinancialAccount, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.FinancialAccount
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Type != nil {
		updates["type"] = *in.Type
	}
	if in.Balance != nil {
		d, err := decimal.FromString(*in.Balance)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad balance", err)
		}
		updates["balance"] = d
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.FinancialAccount
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete — 409 если есть FinancialOperation на этот аккаунт.
func (s *FinancialAccountsService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	var existing models.FinancialAccount
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.ErrNotFound
		}
		return err
	}
	scopedCheck, _ := s.r.ForTenant(ctx)
	var refs int64
	if err := scopedCheck.Model(&models.FinancialOperation{}).
		Where("account_id = ?", id).Count(&refs).Error; err != nil {
		return err
	}
	if refs > 0 {
		return apperrors.Wrap("CONFLICT", "account has financial operations", nil)
	}
	scopedDel, _ := s.r.ForTenant(ctx)
	res := scopedDel.Where("id = ?", id).Delete(&models.FinancialAccount{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// Transfer — атомарный перевод между двумя счетами. Создаёт две FinancialOperation,
// обновляет балансы обоих счетов в одной транзакции.
func (s *FinancialAccountsService) Transfer(ctx context.Context, in AccountTransferInput) (*AccountTransferResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.FromID == nil || *in.FromID == "" || in.ToID == nil || *in.ToID == "" {
		return nil, apperrors.Wrap("VALIDATION", "from_id and to_id are required", nil)
	}
	if *in.FromID == *in.ToID {
		return nil, apperrors.Wrap("VALIDATION", "from_id and to_id must differ", nil)
	}
	if in.Amount == nil || *in.Amount == "" {
		return nil, apperrors.Wrap("VALIDATION", "amount is required", nil)
	}
	amount, err := decimal.FromString(*in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive decimal", err)
	}

	var result AccountTransferResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var from, to models.FinancialAccount
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, *in.FromID).First(&from).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("NOT_FOUND", "from account not found", nil)
			}
			return err
		}
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, *in.ToID).First(&to).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("NOT_FOUND", "to account not found", nil)
			}
			return err
		}
		if decimal.IsNegative(decimal.Sub(from.Balance, amount)) {
			return apperrors.Wrap("CONFLICT", "insufficient funds on from account", nil)
		}
		newFrom := decimal.Normalize(decimal.Sub(from.Balance, amount))
		newTo := decimal.Normalize(decimal.Add(to.Balance, amount))
		now := time.Now().UTC()
		date := now.Format("2006-01-02")
		if err := tx.Model(&from).Updates(map[string]any{"balance": newFrom, "updated_at": now}).Error; err != nil {
			return err
		}
		if err := tx.Model(&to).Updates(map[string]any{"balance": newTo, "updated_at": now}).Error; err != nil {
			return err
		}
		category := "Перевод"
		activity := "financial"
		ridStr := rid
		isAuto := false
		desc := in.Description

		toName := ""
		if to.Name != nil {
			toName = *to.Name
		}
		fromName := ""
		if from.Name != nil {
			fromName = *from.Name
		}
		fromID := from.ID
		toID := to.ID

		outType := "out"
		opOut := &models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         &outType,
			Amount:       amount,
			Category:     &category,
			AccountID:    &fromID,
			AccountName:  from.Name,
			Activity:     &activity,
			Date:         &date,
			Description:  desc,
			Counterparty: &toName,
			IsAuto:       &isAuto,
			RestaurantID: &ridStr,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(opOut).Error; err != nil {
			return err
		}
		inType := "in"
		opIn := &models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         &inType,
			Amount:       amount,
			Category:     &category,
			AccountID:    &toID,
			AccountName:  to.Name,
			Activity:     &activity,
			Date:         &date,
			Description:  desc,
			Counterparty: &fromName,
			IsAuto:       &isAuto,
			RestaurantID: &ridStr,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Create(opIn).Error; err != nil {
			return err
		}
		result.From = *opOut
		result.To = *opIn
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &result, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// FinancialOperations — paged list + manual create
// ═══════════════════════════════════════════════════════════════════════════

type FinancialOperationsService struct{ r *repo.Repo }

func NewFinancialOperationsService(r *repo.Repo) *FinancialOperationsService {
	return &FinancialOperationsService{r: r}
}

type FinancialOperationsFilter struct {
	From, To  *time.Time
	Type      string
	AccountID string
	Category  string
	Activity  string
	ShiftID   string
	Page      cursor.Page
}

func (s *FinancialOperationsService) List(ctx context.Context, f FinancialOperationsFilter) ([]models.FinancialOperation, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.Type != "" {
		q = q.Where("type = ?", f.Type)
	}
	if f.AccountID != "" {
		q = q.Where("account_id = ?", f.AccountID)
	}
	if f.Category != "" {
		q = q.Where("category = ?", f.Category)
	}
	if f.Activity != "" {
		q = q.Where("activity = ?", f.Activity)
	}
	if f.ShiftID != "" {
		q = q.Where("shift_id = ?", f.ShiftID)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	q = cursor.Apply(q, "financial_operations", f.Page)
	var rows []models.FinancialOperation
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.FinancialOperation) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

type FinancialOperationInput struct {
	Type         *string `json:"type,omitempty"`
	Amount       *string `json:"amount,omitempty"`
	Category     *string `json:"category,omitempty"`
	AccountID    *string `json:"account_id,omitempty"`
	Activity     *string `json:"activity,omitempty"`
	Date         *string `json:"date,omitempty"`
	Description  *string `json:"description,omitempty"`
	Counterparty *string `json:"counterparty,omitempty"`
	ShiftID      *string `json:"shift_id,omitempty"`
}

// Create — ручная финансовая операция (Manager). Обновляет баланс счёта в той же tx.
// Тип transfer тут запрещён — используйте /accounts/transfer.
func (s *FinancialOperationsService) Create(ctx context.Context, in FinancialOperationInput) (*models.FinancialOperation, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Type == nil || (*in.Type != "in" && *in.Type != "out") {
		return nil, apperrors.Wrap("VALIDATION", "type must be 'in' or 'out'", nil)
	}
	if in.Amount == nil || *in.Amount == "" {
		return nil, apperrors.Wrap("VALIDATION", "amount is required", nil)
	}
	amount, err := decimal.FromString(*in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive", err)
	}
	if in.Category == nil || *in.Category == "" {
		return nil, apperrors.Wrap("VALIDATION", "category is required", nil)
	}
	if in.AccountID == nil || *in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "account_id is required", nil)
	}
	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	if in.Date != nil && *in.Date != "" {
		date = *in.Date
	}
	activity := "operational"
	if in.Activity != nil && *in.Activity != "" {
		activity = *in.Activity
	}
	isAuto := false
	ridStr := rid

	var op models.FinancialOperation
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var acc models.FinancialAccount
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, *in.AccountID).First(&acc).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "account not found", nil)
			}
			return err
		}
		var newBal decimal.Decimal
		if *in.Type == "in" {
			newBal = decimal.Normalize(decimal.Add(acc.Balance, amount))
		} else {
			if decimal.IsNegative(decimal.Sub(acc.Balance, amount)) {
				return apperrors.Wrap("CONFLICT", "insufficient funds on account", nil)
			}
			newBal = decimal.Normalize(decimal.Sub(acc.Balance, amount))
		}
		if err := tx.Model(&acc).Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
			return err
		}
		op = models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         in.Type,
			Amount:       amount,
			Category:     in.Category,
			AccountID:    in.AccountID,
			AccountName:  acc.Name,
			Activity:     &activity,
			Date:         &date,
			Description:  in.Description,
			Counterparty: in.Counterparty,
			IsAuto:       &isAuto,
			ShiftID:      in.ShiftID,
			RestaurantID: &ridStr,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		return tx.Create(&op).Error
	})
	if err != nil {
		return nil, err
	}
	return &op, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// CustomCategories CRUD
// ═══════════════════════════════════════════════════════════════════════════

type CustomCategoriesService struct{ r *repo.Repo }

func NewCustomCategoriesService(r *repo.Repo) *CustomCategoriesService {
	return &CustomCategoriesService{r: r}
}

type CustomCategoryInput struct {
	Name *string `json:"name,omitempty"`
	Type *string `json:"type,omitempty"`
}

func (s *CustomCategoriesService) List(ctx context.Context, typeFilter string) ([]models.CustomCategory, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	q := scoped
	if typeFilter != "" {
		q = q.Where("type = ?", typeFilter)
	}
	var rows []models.CustomCategory
	if err := q.Order("name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *CustomCategoriesService) Create(ctx context.Context, in CustomCategoryInput) (*models.CustomCategory, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	t := "out"
	if in.Type != nil && *in.Type != "" {
		t = *in.Type
	}
	if t != "in" && t != "out" {
		return nil, apperrors.Wrap("VALIDATION", "type must be 'in' or 'out'", nil)
	}
	c := &models.CustomCategory{
		ID: uuid.NewString(), Name: *in.Name, Type: t,
		RestaurantID: &rid, CreatedAt: time.Now().UTC(),
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(c).Error; err != nil {
		return nil, err
	}
	return c, nil
}

func (s *CustomCategoriesService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.CustomCategory{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ═══════════════════════════════════════════════════════════════════════════
// FinanceReportsService — JSON-отчёты P&L / Cashflow / Balance / MonthlyRevenue
// ═══════════════════════════════════════════════════════════════════════════

type FinanceReportsService struct{ r *repo.Repo }

func NewFinanceReportsService(r *repo.Repo) *FinanceReportsService {
	return &FinanceReportsService{r: r}
}

type PnLJSON struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	Revenue struct {
		Total    decimal.Decimal `json:"total"`
		ByMethod []ByMethodRow   `json:"by_method"`
	} `json:"revenue"`
	COGS struct {
		Total decimal.Decimal `json:"total"`
	} `json:"cogs"`
	Opex struct {
		Total      decimal.Decimal `json:"total"`
		ByCategory []ByCategoryRow `json:"by_category"`
	} `json:"opex"`
	GrossProfit   decimal.Decimal `json:"gross_profit"`
	NetProfit     decimal.Decimal `json:"net_profit"`
	MarginPercent decimal.Decimal `json:"margin_percent"`
}

type ByMethodRow struct {
	Method string          `json:"method"`
	Amount decimal.Decimal `json:"amount"`
}

type ByCategoryRow struct {
	Category string          `json:"category"`
	Amount   decimal.Decimal `json:"amount"`
}

func (s *FinanceReportsService) PnL(ctx context.Context, f PeriodFilter) (*PnLJSON, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	out := &PnLJSON{}
	out.Period.From = f.From
	out.Period.To = f.To

	scoped, _ := s.r.ForTenant(ctx)
	// Revenue total + by payment_method.
	type revRow struct {
		Method string          `gorm:"column:method"`
		Total  decimal.Decimal `gorm:"column:total"`
	}
	q := scoped.Table("orders").
		Select("COALESCE(payment_method, '') AS method, COALESCE(SUM(total_with_service), 0) AS total").
		Where("status = ? AND closed_at IS NOT NULL", "closed")
	if f.From != nil {
		q = q.Where("closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("closed_at < ?", *f.To)
	}
	var revRows []revRow
	if err := q.Group("payment_method").Scan(&revRows).Error; err != nil {
		return nil, err
	}
	out.Revenue.Total = decimal.Zero
	out.Revenue.ByMethod = make([]ByMethodRow, 0, len(revRows))
	for _, r := range revRows {
		out.Revenue.Total = decimal.Add(out.Revenue.Total, r.Total)
		out.Revenue.ByMethod = append(out.Revenue.ByMethod, ByMethodRow{Method: r.Method, Amount: decimal.Normalize(r.Total)})
	}
	out.Revenue.Total = decimal.Normalize(out.Revenue.Total)

	// COGS = sum(order_items.cogs * order_items.qty) for closed orders in period.
	scoped2, _ := s.r.ForTenant(ctx)
	type cogsRow struct {
		Total decimal.Decimal `gorm:"column:total"`
	}
	q2 := scoped2.Table("orders AS o").
		Select("COALESCE(SUM(oi.cogs * oi.qty), 0) AS total").
		Joins("JOIN order_items oi ON oi.order_id = o.id").
		Where("o.status = ? AND o.closed_at IS NOT NULL AND oi.cancelled_at IS NULL", "closed")
	if f.From != nil {
		q2 = q2.Where("o.closed_at >= ?", *f.From)
	}
	if f.To != nil {
		q2 = q2.Where("o.closed_at < ?", *f.To)
	}
	var cogsRows []cogsRow
	if err := q2.Scan(&cogsRows).Error; err != nil {
		return nil, err
	}
	if len(cogsRows) > 0 {
		out.COGS.Total = decimal.Normalize(cogsRows[0].Total)
	}

	// Opex from financial_operations type='out' grouped by category.
	scoped3, _ := s.r.ForTenant(ctx)
	type opexRow struct {
		Category string          `gorm:"column:category"`
		Total    decimal.Decimal `gorm:"column:total"`
	}
	q3 := scoped3.Table("financial_operations").
		Select("COALESCE(category, '') AS category, COALESCE(SUM(amount), 0) AS total").
		Where("type = ?", "out")
	if f.From != nil {
		q3 = q3.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q3 = q3.Where("created_at < ?", *f.To)
	}
	var opexRows []opexRow
	if err := q3.Group("category").Scan(&opexRows).Error; err != nil {
		return nil, err
	}
	out.Opex.Total = decimal.Zero
	out.Opex.ByCategory = make([]ByCategoryRow, 0, len(opexRows))
	for _, r := range opexRows {
		out.Opex.Total = decimal.Add(out.Opex.Total, r.Total)
		out.Opex.ByCategory = append(out.Opex.ByCategory, ByCategoryRow{Category: r.Category, Amount: decimal.Normalize(r.Total)})
	}
	out.Opex.Total = decimal.Normalize(out.Opex.Total)

	out.GrossProfit = decimal.Normalize(decimal.Sub(out.Revenue.Total, out.COGS.Total))
	out.NetProfit = decimal.Normalize(decimal.Sub(out.GrossProfit, out.Opex.Total))
	if decimal.IsPositive(out.Revenue.Total) {
		out.MarginPercent = decimal.Normalize(decimal.Mul(decimal.DivRound(out.NetProfit, out.Revenue.Total), decimal.FromInt(100)))
	} else {
		out.MarginPercent = decimal.Zero
	}
	_ = rid
	return out, nil
}

type CashflowJSON struct {
	Period struct {
		From *time.Time `json:"from,omitempty"`
		To   *time.Time `json:"to,omitempty"`
	} `json:"period"`
	ByActivity map[string]ActivityRow `json:"by_activity"`
	NetTotal   decimal.Decimal        `json:"net_total"`
	ByDay      []DayRow               `json:"by_day"`
}

type ActivityRow struct {
	In  decimal.Decimal `json:"in"`
	Out decimal.Decimal `json:"out"`
	Net decimal.Decimal `json:"net"`
}

type DayRow struct {
	Date string          `json:"date"`
	In   decimal.Decimal `json:"in"`
	Out  decimal.Decimal `json:"out"`
}

func (s *FinanceReportsService) Cashflow(ctx context.Context, f PeriodFilter) (*CashflowJSON, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &CashflowJSON{ByActivity: map[string]ActivityRow{}}
	out.Period.From = f.From
	out.Period.To = f.To

	type actRow struct {
		Activity string          `gorm:"column:activity"`
		Type     string          `gorm:"column:type"`
		Total    decimal.Decimal `gorm:"column:total"`
	}
	q := scoped.Table("financial_operations").
		Select("COALESCE(activity, 'operational') AS activity, COALESCE(type, '') AS type, COALESCE(SUM(amount), 0) AS total")
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	var rows []actRow
	if err := q.Group("activity, type").Scan(&rows).Error; err != nil {
		return nil, err
	}
	net := decimal.Zero
	for _, r := range rows {
		ar := out.ByActivity[r.Activity]
		if r.Type == "in" {
			ar.In = decimal.Normalize(decimal.Add(ar.In, r.Total))
			net = decimal.Add(net, r.Total)
		} else if r.Type == "out" {
			ar.Out = decimal.Normalize(decimal.Add(ar.Out, r.Total))
			net = decimal.Sub(net, r.Total)
		}
		ar.Net = decimal.Normalize(decimal.Sub(ar.In, ar.Out))
		out.ByActivity[r.Activity] = ar
	}
	out.NetTotal = decimal.Normalize(net)

	// By day.
	scoped2, _ := s.r.ForTenant(ctx)
	type dayRow struct {
		Day   string          `gorm:"column:day"`
		Type  string          `gorm:"column:type"`
		Total decimal.Decimal `gorm:"column:total"`
	}
	q2 := scoped2.Table("financial_operations").
		Select("to_char(created_at, 'YYYY-MM-DD') AS day, COALESCE(type, '') AS type, COALESCE(SUM(amount), 0) AS total")
	if f.From != nil {
		q2 = q2.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q2 = q2.Where("created_at < ?", *f.To)
	}
	var drows []dayRow
	if err := q2.Group("day, type").Order("day ASC").Scan(&drows).Error; err != nil {
		return nil, err
	}
	dayMap := map[string]*DayRow{}
	keys := []string{}
	for _, r := range drows {
		d, ok := dayMap[r.Day]
		if !ok {
			d = &DayRow{Date: r.Day, In: decimal.Zero, Out: decimal.Zero}
			dayMap[r.Day] = d
			keys = append(keys, r.Day)
		}
		if r.Type == "in" {
			d.In = decimal.Normalize(decimal.Add(d.In, r.Total))
		} else if r.Type == "out" {
			d.Out = decimal.Normalize(decimal.Add(d.Out, r.Total))
		}
	}
	out.ByDay = make([]DayRow, 0, len(keys))
	for _, k := range keys {
		out.ByDay = append(out.ByDay, *dayMap[k])
	}
	return out, nil
}

type BalanceJSON struct {
	Assets           []BalanceLine   `json:"assets"`
	TotalAssets      decimal.Decimal `json:"total_assets"`
	Liabilities      []LiabilityLine `json:"liabilities"`
	TotalLiabilities decimal.Decimal `json:"total_liabilities"`
	Equity           []BalanceLine   `json:"equity"`
	TotalEquity      decimal.Decimal `json:"total_equity"`
	ComputedEquity   decimal.Decimal `json:"computed_equity"`
}

type BalanceLine struct {
	ID     string          `json:"id"`
	Name   string          `json:"name"`
	Amount decimal.Decimal `json:"amount"`
}

type LiabilityLine struct {
	ID        string          `json:"id"`
	Name      string          `json:"name"`
	Total     decimal.Decimal `json:"total"`
	Paid      decimal.Decimal `json:"paid"`
	Remaining decimal.Decimal `json:"remaining"`
}

func (s *FinanceReportsService) Balance(ctx context.Context) (*BalanceJSON, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	out := &BalanceJSON{
		Assets: []BalanceLine{}, Liabilities: []LiabilityLine{}, Equity: []BalanceLine{},
	}
	var assets []models.Asset
	if err := scoped.Order("name ASC").Find(&assets).Error; err != nil {
		return nil, err
	}
	out.TotalAssets = decimal.Zero
	for _, a := range assets {
		name := ""
		if a.Name != nil {
			name = *a.Name
		}
		out.Assets = append(out.Assets, BalanceLine{ID: a.ID, Name: name, Amount: a.Amount})
		out.TotalAssets = decimal.Add(out.TotalAssets, a.Amount)
	}
	out.TotalAssets = decimal.Normalize(out.TotalAssets)

	scoped2, _ := s.r.ForTenant(ctx)
	var liabs []models.Liability
	if err := scoped2.Order("name ASC").Find(&liabs).Error; err != nil {
		return nil, err
	}
	out.TotalLiabilities = decimal.Zero
	for _, l := range liabs {
		name := ""
		if l.Name != nil {
			name = *l.Name
		}
		out.Liabilities = append(out.Liabilities, LiabilityLine{
			ID: l.ID, Name: name, Total: l.TotalAmount, Paid: l.PaidAmount, Remaining: l.RemainingAmount,
		})
		out.TotalLiabilities = decimal.Add(out.TotalLiabilities, l.RemainingAmount)
	}
	out.TotalLiabilities = decimal.Normalize(out.TotalLiabilities)

	scoped3, _ := s.r.ForTenant(ctx)
	var equity []models.EquityEntry
	if err := scoped3.Order("name ASC").Find(&equity).Error; err != nil {
		return nil, err
	}
	out.TotalEquity = decimal.Zero
	for _, e := range equity {
		name := ""
		if e.Name != nil {
			name = *e.Name
		}
		out.Equity = append(out.Equity, BalanceLine{ID: e.ID, Name: name, Amount: e.Amount})
		out.TotalEquity = decimal.Add(out.TotalEquity, e.Amount)
	}
	out.TotalEquity = decimal.Normalize(out.TotalEquity)
	out.ComputedEquity = decimal.Normalize(decimal.Sub(out.TotalAssets, out.TotalLiabilities))
	return out, nil
}

type MonthlyRevenueRow struct {
	Month       string          `json:"month"`
	Revenue     decimal.Decimal `json:"revenue"`
	OrdersCount int             `json:"orders_count"`
	AvgCheck    decimal.Decimal `json:"avg_check"`
	Expenses    decimal.Decimal `json:"expenses"`
	Profit      decimal.Decimal `json:"profit"`
}

// MonthlyRevenue — последние N месяцев от now (или указанного года).
func (s *FinanceReportsService) MonthlyRevenue(ctx context.Context, months int) ([]MonthlyRevenueRow, error) {
	if months <= 0 {
		months = 12
	}
	if months > 60 {
		months = 60
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	// Граница "от" — начало месяца now-(months-1).
	now := time.Now().UTC()
	startMonth := time.Date(now.Year(), now.Month(), 1, 0, 0, 0, 0, time.UTC).AddDate(0, -(months - 1), 0)

	type row struct {
		Month string          `gorm:"column:month"`
		Total decimal.Decimal `gorm:"column:total"`
		Cnt   int             `gorm:"column:cnt"`
	}
	var rows []row
	if err := scoped.Table("orders").
		Select("to_char(closed_at, 'YYYY-MM') AS month, COALESCE(SUM(total_with_service), 0) AS total, COUNT(*) AS cnt").
		Where("status = ? AND closed_at IS NOT NULL AND closed_at >= ?", "closed", startMonth).
		Group("month").
		Order("month ASC").
		Scan(&rows).Error; err != nil {
		return nil, err
	}
	byMonth := map[string]row{}
	for _, r := range rows {
		byMonth[r.Month] = r
	}

	// expenses: SUM(financial_operations.amount) WHERE type='out' AND activity='operational',
	// сгруппировано по месяцу date (или created_at если date NULL).
	type expRow struct {
		Month string          `gorm:"column:month"`
		Total decimal.Decimal `gorm:"column:total"`
	}
	scopedE, _ := s.r.ForTenant(ctx)
	var expRows []expRow
	if err := scopedE.Table("financial_operations").
		Select("to_char(COALESCE(date::timestamptz, created_at), 'YYYY-MM') AS month, COALESCE(SUM(amount), 0) AS total").
		Where("type = ? AND activity = ? AND COALESCE(date::timestamptz, created_at) >= ?", "out", "operational", startMonth).
		Group("month").
		Scan(&expRows).Error; err != nil {
		return nil, err
	}
	byMonthExp := map[string]decimal.Decimal{}
	for _, r := range expRows {
		byMonthExp[r.Month] = r.Total
	}

	out := make([]MonthlyRevenueRow, 0, months)
	for i := 0; i < months; i++ {
		t := startMonth.AddDate(0, i, 0)
		key := t.Format("2006-01")
		r, ok := byMonth[key]
		var avg decimal.Decimal
		if ok && r.Cnt > 0 {
			avg = decimal.Normalize(decimal.DivRound(r.Total, decimal.FromInt(int64(r.Cnt))))
		} else {
			avg = decimal.Zero
		}
		total := decimal.Zero
		cnt := 0
		if ok {
			total = decimal.Normalize(r.Total)
			cnt = r.Cnt
		}
		exp := decimal.Normalize(byMonthExp[key])
		profit := decimal.Normalize(decimal.Sub(total, exp))
		out = append(out, MonthlyRevenueRow{
			Month: key, Revenue: total, OrdersCount: cnt, AvgCheck: avg,
			Expenses: exp, Profit: profit,
		})
	}
	return out, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// SalaryService — выплата ЗП и сервис-чарджа сотрудникам.
// ═══════════════════════════════════════════════════════════════════════════

type SalaryService struct{ r *repo.Repo }

func NewSalaryService(r *repo.Repo) *SalaryService { return &SalaryService{r: r} }

type SalaryPayInput struct {
	UserID       *string `json:"user_id,omitempty"`
	Amount       *string `json:"amount,omitempty"`
	AccountID    *string `json:"account_id,omitempty"`
	EmployeeName *string `json:"employee_name,omitempty"`
	Period       *string `json:"period,omitempty"`
	Description  *string `json:"description,omitempty"`
}

func (s *SalaryService) PaySalary(ctx context.Context, in SalaryPayInput) (*models.FinancialOperation, error) {
	return s.payout(ctx, payoutInput{
		UserID:       in.UserID,
		Amount:       in.Amount,
		AccountID:    in.AccountID,
		Counterparty: in.EmployeeName,
		Category:     "Зарплата",
		Period:       in.Period,
		Description:  in.Description,
	})
}

type ServiceChargePayInput struct {
	WaiterID    *string `json:"waiter_id,omitempty"`
	Amount      *string `json:"amount,omitempty"`
	AccountID   *string `json:"account_id,omitempty"`
	PeriodFrom  *string `json:"period_from,omitempty"`
	PeriodTo    *string `json:"period_to,omitempty"`
	Description *string `json:"description,omitempty"`
}

func (s *SalaryService) PayServiceCharge(ctx context.Context, in ServiceChargePayInput) (*models.FinancialOperation, error) {
	period := ""
	if in.PeriodFrom != nil && in.PeriodTo != nil {
		period = *in.PeriodFrom + "..." + *in.PeriodTo
	}
	// Counterparty = имя официанта (lookup by waiter_id).
	var counterparty string
	if in.WaiterID != nil && *in.WaiterID != "" {
		scoped, err := s.r.ForTenant(ctx)
		if err != nil {
			return nil, err
		}
		var u models.User
		if err := scoped.Where("id = ?", *in.WaiterID).First(&u).Error; err == nil {
			if u.Name != nil {
				counterparty = *u.Name
			}
		}
	}
	cp := counterparty
	return s.payout(ctx, payoutInput{
		UserID:       in.WaiterID,
		Amount:       in.Amount,
		AccountID:    in.AccountID,
		Counterparty: &cp,
		Category:     "Сервис",
		Period:       &period,
		Description:  in.Description,
	})
}

type payoutInput struct {
	UserID       *string
	Amount       *string
	AccountID    *string
	Counterparty *string
	Category     string
	Period       *string
	Description  *string
}

func (s *SalaryService) payout(ctx context.Context, in payoutInput) (*models.FinancialOperation, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.UserID == nil || *in.UserID == "" {
		return nil, apperrors.Wrap("VALIDATION", "user_id/waiter_id is required", nil)
	}
	if in.Amount == nil || *in.Amount == "" {
		return nil, apperrors.Wrap("VALIDATION", "amount is required", nil)
	}
	amount, err := decimal.FromString(*in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be positive", err)
	}
	if in.AccountID == nil || *in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "account_id is required", nil)
	}
	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	outType := "out"
	activity := "operational"
	category := in.Category
	isAuto := false
	srcRef := *in.UserID
	ridStr := rid

	desc := in.Description
	if (desc == nil || *desc == "") && in.Period != nil && *in.Period != "" {
		p := fmt.Sprintf("%s:%s", category, *in.Period)
		desc = &p
	}

	var op models.FinancialOperation
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var acc models.FinancialAccount
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, *in.AccountID).First(&acc).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.Wrap("VALIDATION", "account not found", nil)
			}
			return err
		}
		if decimal.IsNegative(decimal.Sub(acc.Balance, amount)) {
			return apperrors.Wrap("CONFLICT", "insufficient funds", nil)
		}
		newBal := decimal.Normalize(decimal.Sub(acc.Balance, amount))
		if err := tx.Model(&acc).Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
			return err
		}
		op = models.FinancialOperation{
			ID:           uuid.NewString(),
			Type:         &outType,
			Amount:       amount,
			Category:     &category,
			AccountID:    in.AccountID,
			AccountName:  acc.Name,
			Activity:     &activity,
			Date:         &date,
			Description:  desc,
			Counterparty: in.Counterparty,
			IsAuto:       &isAuto,
			SourceRef:    &srcRef,
			RestaurantID: &ridStr,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		return tx.Create(&op).Error
	})
	if err != nil {
		return nil, err
	}
	return &op, nil
}

// ServiceAccrualRow / ServicePayoutRow — для сводок по официанту.
type ServiceAccrualRow struct {
	WaiterID      string          `json:"waiter_id"`
	WaiterName    string          `json:"waiter_name"`
	TotalOrders   int             `json:"total_orders"`
	TotalRevenue  decimal.Decimal `json:"total_revenue"`
	AccruedAmount decimal.Decimal `json:"accrued_amount"`
}

type ServicePayoutRow struct {
	WaiterID   string          `json:"waiter_id"`
	WaiterName string          `json:"waiter_name"`
	PaidAmount decimal.Decimal `json:"paid_amount"`
}

// AccrualByWaiter — начисление service-charge за период, сгруппированное по официанту.
// Сумма = SUM(oi.qty * oi.price * o.service_percent / 100) for closed orders.
func (s *SalaryService) AccrualByWaiter(ctx context.Context, from, to *time.Time, shiftID string) ([]ServiceAccrualRow, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	type row struct {
		WaiterID   string          `gorm:"column:waiter_id"`
		WaiterName string          `gorm:"column:waiter_name"`
		Cnt        int             `gorm:"column:cnt"`
		Revenue    decimal.Decimal `gorm:"column:revenue"`
		Accrued    decimal.Decimal `gorm:"column:accrued"`
	}
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	q := raw.Table("orders AS o").
		Select(`COALESCE(o.waiter_id::text, '') AS waiter_id,
		        COALESCE(u.name, '') AS waiter_name,
		        COUNT(DISTINCT o.id) AS cnt,
		        COALESCE(SUM(o.total_with_service), 0) AS revenue,
		        COALESCE(SUM(oi.qty * oi.price * o.service_percent / 100.0), 0) AS accrued`).
		Joins("LEFT JOIN order_items oi ON oi.order_id = o.id AND oi.cancelled_at IS NULL").
		Joins("LEFT JOIN users u ON u.id::text = o.waiter_id::text").
		Where("o.restaurant_id = ? AND o.status = ? AND o.closed_at IS NOT NULL", rid, "closed").
		Where("o.waiter_id IS NOT NULL")
	if from != nil {
		q = q.Where("o.closed_at >= ?", *from)
	}
	if to != nil {
		q = q.Where("o.closed_at < ?", *to)
	}
	if shiftID != "" {
		q = q.Where("o.shift_id = ?", shiftID)
	}
	var rows []row
	if err := q.Group("o.waiter_id, u.name").Order("u.name ASC").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]ServiceAccrualRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, ServiceAccrualRow{
			WaiterID:      r.WaiterID,
			WaiterName:    r.WaiterName,
			TotalOrders:   r.Cnt,
			TotalRevenue:  decimal.Normalize(r.Revenue),
			AccruedAmount: decimal.Normalize(r.Accrued),
		})
	}
	return out, nil
}

// PayoutByWaiter — суммарные выплаты service-charge ('Сервис'%) за период.
func (s *SalaryService) PayoutByWaiter(ctx context.Context, from, to *time.Time, shiftID string) ([]ServicePayoutRow, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	type row struct {
		SourceRef string          `gorm:"column:source_ref"`
		Name      string          `gorm:"column:name"`
		Total     decimal.Decimal `gorm:"column:total"`
	}
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	q := raw.Table("financial_operations AS fo").
		Select(`COALESCE(fo.source_ref, '') AS source_ref,
		        COALESCE(u.name, COALESCE(fo.counterparty, '')) AS name,
		        COALESCE(SUM(fo.amount), 0) AS total`).
		Joins("LEFT JOIN users u ON u.id::text = fo.source_ref").
		Where("fo.restaurant_id = ? AND fo.type = ?", rid, "out").
		Where("fo.category ILIKE ?", "Сервис%")
	if from != nil {
		q = q.Where("fo.created_at >= ?", *from)
	}
	if to != nil {
		q = q.Where("fo.created_at < ?", *to)
	}
	if shiftID != "" {
		q = q.Where("fo.shift_id = ?", shiftID)
	}
	var rows []row
	if err := q.Group("fo.source_ref, u.name, fo.counterparty").Order("name ASC").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]ServicePayoutRow, 0, len(rows))
	for _, r := range rows {
		out = append(out, ServicePayoutRow{
			WaiterID:   r.SourceRef,
			WaiterName: r.Name,
			PaidAmount: decimal.Normalize(r.Total),
		})
	}
	return out, nil
}
