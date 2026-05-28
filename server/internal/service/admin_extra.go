// admin_extra — оставшиеся CRUD'ы Owner/Manager-уровня:
//   - Finance: Assets, Liabilities, EquityEntries, BudgetLines
//   - Payroll: TimeEntries (clock_in/out)
//   - Menu extra: Modifiers, ModifierGroups, TechCardLines
//   - Semi-finished: SemiFinishedTypes, SemiRecipeLines, SemiFinishedStock
//
// Все по одному паттерну List/Create/Patch/Delete с ForTenant.
package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ═══════════════════════════════════════════════════════════════════════════
// Finance: Assets / Liabilities / EquityEntries / BudgetLines
// ═══════════════════════════════════════════════════════════════════════════

// ─── Assets ────────────────────────────────────────────────────────────────

type AssetsService struct{ r *repo.Repo }

func NewAssetsService(r *repo.Repo) *AssetsService { return &AssetsService{r: r} }

type AssetInput struct {
	Name             *string `json:"name,omitempty"`
	Category         *string `json:"category,omitempty"`
	Amount           *string `json:"amount,omitempty"`
	PurchaseDate     *string `json:"purchase_date,omitempty"`
	UsefulLifeMonths *int    `json:"useful_life_months,omitempty"`
	Note             *string `json:"note,omitempty"`
}

func (s *AssetsService) List(ctx context.Context) ([]models.Asset, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.Asset
	if err := scoped.Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *AssetsService) Create(ctx context.Context, in AssetInput) (*models.Asset, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	a := &models.Asset{
		ID: uuid.NewString(), Name: in.Name, Category: in.Category,
		PurchaseDate: in.PurchaseDate, UsefulLifeMonths: in.UsefulLifeMonths, Note: in.Note,
		RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	if in.Amount != nil {
		d, err := decimal.FromString(*in.Amount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad amount", err)
		}
		a.Amount = d
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(a).Error; err != nil {
		return nil, err
	}
	return a, nil
}

func (s *AssetsService) Patch(ctx context.Context, id string, in AssetInput) (*models.Asset, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Asset
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
	if in.Category != nil {
		updates["category"] = *in.Category
	}
	if in.PurchaseDate != nil {
		updates["purchase_date"] = *in.PurchaseDate
	}
	if in.UsefulLifeMonths != nil {
		updates["useful_life_months"] = *in.UsefulLifeMonths
	}
	if in.Note != nil {
		updates["note"] = *in.Note
	}
	if in.Amount != nil {
		d, err := decimal.FromString(*in.Amount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad amount", err)
		}
		updates["amount"] = d
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.Asset
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *AssetsService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.Asset{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ─── Liabilities ───────────────────────────────────────────────────────────

type LiabilitiesService struct{ r *repo.Repo }

func NewLiabilitiesService(r *repo.Repo) *LiabilitiesService { return &LiabilitiesService{r: r} }

type LiabilityInput struct {
	Name           *string `json:"name,omitempty"`
	Category       *string `json:"category,omitempty"`
	TotalAmount    *string `json:"total_amount,omitempty"`
	PaidAmount     *string `json:"paid_amount,omitempty"`
	Creditor       *string `json:"creditor,omitempty"`
	DueDate        *string `json:"due_date,omitempty"`
	MonthlyPayment *string `json:"monthly_payment,omitempty"`
	InterestRate   *string `json:"interest_rate,omitempty"`
	Note           *string `json:"note,omitempty"`
}

func (s *LiabilitiesService) List(ctx context.Context) ([]models.Liability, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.Liability
	if err := scoped.Order("due_date ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *LiabilitiesService) Create(ctx context.Context, in LiabilityInput) (*models.Liability, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	l := &models.Liability{
		ID: uuid.NewString(), Name: in.Name, Category: in.Category,
		Creditor: in.Creditor, DueDate: in.DueDate, Note: in.Note,
		RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	if in.TotalAmount != nil {
		d, err := decimal.FromString(*in.TotalAmount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad total_amount", err)
		}
		l.TotalAmount = d
		l.RemainingAmount = d
	}
	if in.PaidAmount != nil {
		d, err := decimal.FromString(*in.PaidAmount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad paid_amount", err)
		}
		l.PaidAmount = d
		l.RemainingAmount = decimal.Normalize(decimal.Sub(l.TotalAmount, d))
	}
	if in.MonthlyPayment != nil {
		d, err := decimal.FromString(*in.MonthlyPayment)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad monthly_payment", err)
		}
		l.MonthlyPayment = d
	}
	if in.InterestRate != nil {
		d, err := decimal.FromString(*in.InterestRate)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad interest_rate", err)
		}
		l.InterestRate = &d
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(l).Error; err != nil {
		return nil, err
	}
	return l, nil
}

func (s *LiabilitiesService) Patch(ctx context.Context, id string, in LiabilityInput) (*models.Liability, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Liability
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
	if in.Category != nil {
		updates["category"] = *in.Category
	}
	if in.Creditor != nil {
		updates["creditor"] = *in.Creditor
	}
	if in.DueDate != nil {
		updates["due_date"] = *in.DueDate
	}
	if in.Note != nil {
		updates["note"] = *in.Note
	}
	if in.TotalAmount != nil {
		d, err := decimal.FromString(*in.TotalAmount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad total_amount", err)
		}
		updates["total_amount"] = d
	}
	if in.PaidAmount != nil {
		d, err := decimal.FromString(*in.PaidAmount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad paid_amount", err)
		}
		updates["paid_amount"] = d
	}
	if in.MonthlyPayment != nil {
		d, err := decimal.FromString(*in.MonthlyPayment)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad monthly_payment", err)
		}
		updates["monthly_payment"] = d
	}
	if in.InterestRate != nil {
		d, err := decimal.FromString(*in.InterestRate)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad interest_rate", err)
		}
		updates["interest_rate"] = d
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.Liability
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	// Пересчёт remaining_amount всегда сразу.
	out.RemainingAmount = decimal.Normalize(decimal.Sub(out.TotalAmount, out.PaidAmount))
	scoped4, _ := s.r.ForTenant(ctx)
	if err := scoped4.Model(&models.Liability{}).Where("id = ?", id).Update("remaining_amount", out.RemainingAmount).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *LiabilitiesService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.Liability{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ─── EquityEntries ─────────────────────────────────────────────────────────

type EquityService struct{ r *repo.Repo }

func NewEquityService(r *repo.Repo) *EquityService { return &EquityService{r: r} }

type EquityInput struct {
	Name     *string `json:"name,omitempty"`
	Category *string `json:"category,omitempty"`
	Amount   *string `json:"amount,omitempty"`
	Note     *string `json:"note,omitempty"`
}

func (s *EquityService) List(ctx context.Context) ([]models.EquityEntry, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.EquityEntry
	if err := scoped.Order("created_at DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *EquityService) Create(ctx context.Context, in EquityInput) (*models.EquityEntry, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	e := &models.EquityEntry{
		ID: uuid.NewString(), Name: in.Name, Category: in.Category, Note: in.Note,
		RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	if in.Amount != nil {
		d, err := decimal.FromString(*in.Amount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad amount", err)
		}
		e.Amount = d
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(e).Error; err != nil {
		return nil, err
	}
	return e, nil
}

func (s *EquityService) Patch(ctx context.Context, id string, in EquityInput) (*models.EquityEntry, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.EquityEntry
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
	if in.Category != nil {
		updates["category"] = *in.Category
	}
	if in.Note != nil {
		updates["note"] = *in.Note
	}
	if in.Amount != nil {
		d, err := decimal.FromString(*in.Amount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad amount", err)
		}
		updates["amount"] = d
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.EquityEntry
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *EquityService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.EquityEntry{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ─── BudgetLines ───────────────────────────────────────────────────────────

type BudgetService struct{ r *repo.Repo }

func NewBudgetService(r *repo.Repo) *BudgetService { return &BudgetService{r: r} }

type BudgetInput struct {
	Category   *string `json:"category,omitempty"`
	Type       *string `json:"type,omitempty"`
	PlanAmount *string `json:"plan_amount,omitempty"`
	FactAmount *string `json:"fact_amount,omitempty"`
	Period     *string `json:"period,omitempty"`
}

func (s *BudgetService) List(ctx context.Context, period string) ([]models.BudgetLine, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	q := scoped
	if period != "" {
		q = q.Where("period = ?", period)
	}
	var rows []models.BudgetLine
	if err := q.Order("type ASC, category ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *BudgetService) Create(ctx context.Context, in BudgetInput) (*models.BudgetLine, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	b := &models.BudgetLine{
		ID: uuid.NewString(), Category: in.Category, Type: in.Type, Period: in.Period,
		RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	if in.PlanAmount != nil {
		d, err := decimal.FromString(*in.PlanAmount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad plan_amount", err)
		}
		b.PlanAmount = d
	}
	if in.FactAmount != nil {
		d, err := decimal.FromString(*in.FactAmount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad fact_amount", err)
		}
		b.FactAmount = d
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(b).Error; err != nil {
		return nil, err
	}
	return b, nil
}

func (s *BudgetService) Patch(ctx context.Context, id string, in BudgetInput) (*models.BudgetLine, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.BudgetLine
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Category != nil {
		updates["category"] = *in.Category
	}
	if in.Type != nil {
		updates["type"] = *in.Type
	}
	if in.Period != nil {
		updates["period"] = *in.Period
	}
	if in.PlanAmount != nil {
		d, err := decimal.FromString(*in.PlanAmount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad plan_amount", err)
		}
		updates["plan_amount"] = d
	}
	if in.FactAmount != nil {
		d, err := decimal.FromString(*in.FactAmount)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad fact_amount", err)
		}
		updates["fact_amount"] = d
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.BudgetLine
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *BudgetService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.BudgetLine{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Payroll: TimeEntries
// ═══════════════════════════════════════════════════════════════════════════

type TimeEntriesService struct{ r *repo.Repo }

func NewTimeEntriesService(r *repo.Repo) *TimeEntriesService { return &TimeEntriesService{r: r} }

type TimeEntryInput struct {
	UserID       *string `json:"user_id,omitempty"`
	ClockIn      *string `json:"clock_in,omitempty"`  // RFC3339
	ClockOut     *string `json:"clock_out,omitempty"` // RFC3339
	BreakMinutes *int    `json:"break_minutes,omitempty"`
	Status       *string `json:"status,omitempty"`
	Note         *string `json:"note,omitempty"`
}

type TimeEntriesFilter struct {
	UserID string
	From   *time.Time
	To     *time.Time
}

func (s *TimeEntriesService) List(ctx context.Context, f TimeEntriesFilter) ([]models.TimeEntry, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	q := scoped
	if f.UserID != "" {
		q = q.Where("user_id = ?", f.UserID)
	}
	if f.From != nil {
		q = q.Where("clock_in >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("clock_in < ?", *f.To)
	}
	var rows []models.TimeEntry
	if err := q.Order("clock_in DESC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ClockIn — POST /api/v1/time-entries (open shift для юзера).
func (s *TimeEntriesService) ClockIn(ctx context.Context, in TimeEntryInput) (*models.TimeEntry, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.UserID == nil || *in.UserID == "" {
		return nil, apperrors.Wrap("VALIDATION", "user_id is required", nil)
	}
	now := time.Now().UTC()
	in0 := now
	if in.ClockIn != nil {
		t, err := time.Parse(time.RFC3339, *in.ClockIn)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad clock_in", err)
		}
		in0 = t
	}
	active := "active"
	t := &models.TimeEntry{
		ID:           uuid.NewString(),
		UserID:       in.UserID,
		ClockIn:      &in0,
		Status:       &active,
		Note:         in.Note,
		RestaurantID: &rid,
		CreatedAt:    now,
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(t).Error; err != nil {
		return nil, err
	}
	return t, nil
}

// ClockOut — PATCH /api/v1/time-entries/{id}/clock-out.
func (s *TimeEntriesService) ClockOut(ctx context.Context, id string, in TimeEntryInput) (*models.TimeEntry, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.TimeEntry
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if existing.Status != nil && *existing.Status == "closed" {
		return nil, apperrors.Wrap("CONFLICT", "already clocked out", nil)
	}
	out := time.Now().UTC()
	if in.ClockOut != nil {
		t, err := time.Parse(time.RFC3339, *in.ClockOut)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad clock_out", err)
		}
		out = t
	}
	br := 0
	if in.BreakMinutes != nil {
		br = *in.BreakMinutes
	}
	// total_hours = (clock_out - clock_in - break) в часах.
	var totalHours decimal.Decimal
	if existing.ClockIn != nil {
		dur := out.Sub(*existing.ClockIn) - time.Duration(br)*time.Minute
		hoursStr := decimal.MustFromString("0").String()
		_ = hoursStr
		totalHours = decimal.DivRound(decimal.FromInt(int64(dur.Minutes())), decimal.FromInt(60))
	}
	updates := map[string]any{
		"clock_out":     out,
		"break_minutes": br,
		"total_hours":   totalHours,
		"status":        "closed",
	}
	if in.Note != nil {
		updates["note"] = *in.Note
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var refreshed models.TimeEntry
	if err := scoped3.Where("id = ?", id).First(&refreshed).Error; err != nil {
		return nil, err
	}
	return &refreshed, nil
}

func (s *TimeEntriesService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.TimeEntry{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Menu extras: Modifiers, ModifierGroups, TechCardLines
// ═══════════════════════════════════════════════════════════════════════════

type ModifierGroupsService struct{ r *repo.Repo }

func NewModifierGroupsService(r *repo.Repo) *ModifierGroupsService {
	return &ModifierGroupsService{r: r}
}

type ModifierGroupInput struct {
	Name       *string `json:"name,omitempty"`
	MenuItemID *string `json:"menu_item_id,omitempty"`
	IsRequired *bool   `json:"is_required,omitempty"`
	MaxSelect  *int    `json:"max_select,omitempty"`
	SortOrder  *int    `json:"sort_order,omitempty"`
}

// List — GET /menu/modifier-groups?menu_item_id=...
// Семантика menu_item_id:
//   - ""        — все группы (global + item-specific).
//   - "global"  — только global (menu_item_id IS NULL).
//   - "none"    — только item-specific (menu_item_id IS NOT NULL).
//   - <uuid>    — group этого item ИЛИ global (menu_item_id = X OR IS NULL).
func (s *ModifierGroupsService) List(ctx context.Context, menuItemID string) ([]models.ModifierGroup, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	q := scoped
	switch menuItemID {
	case "":
		// no filter
	case "global":
		q = q.Where("menu_item_id IS NULL")
	case "none":
		q = q.Where("menu_item_id IS NOT NULL")
	default:
		q = q.Where("menu_item_id = ? OR menu_item_id IS NULL", menuItemID)
	}
	var rows []models.ModifierGroup
	if err := q.Order("sort_order ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *ModifierGroupsService) Create(ctx context.Context, in ModifierGroupInput) (*models.ModifierGroup, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	g := &models.ModifierGroup{
		ID: uuid.NewString(), Name: in.Name, MenuItemID: in.MenuItemID,
		IsRequired: in.IsRequired, MaxSelect: in.MaxSelect, SortOrder: in.SortOrder,
		RestaurantID: &rid, CreatedAt: now,
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(g).Error; err != nil {
		return nil, err
	}
	return g, nil
}

func (s *ModifierGroupsService) Patch(ctx context.Context, id string, in ModifierGroupInput) (*models.ModifierGroup, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.ModifierGroup
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.MenuItemID != nil {
		updates["menu_item_id"] = *in.MenuItemID
	}
	if in.IsRequired != nil {
		updates["is_required"] = *in.IsRequired
	}
	if in.MaxSelect != nil {
		updates["max_select"] = *in.MaxSelect
	}
	if in.SortOrder != nil {
		updates["sort_order"] = *in.SortOrder
	}
	if len(updates) == 0 {
		return &existing, nil
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.ModifierGroup
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ModifierGroupsService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.ModifierGroup{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

type ModifiersService struct{ r *repo.Repo }

func NewModifiersService(r *repo.Repo) *ModifiersService { return &ModifiersService{r: r} }

type ModifierInput struct {
	GroupID   *string `json:"group_id,omitempty"`
	Name      *string `json:"name,omitempty"`
	Price     *string `json:"price,omitempty"`
	IsDefault *bool   `json:"is_default,omitempty"`
	SortOrder *int    `json:"sort_order,omitempty"`
}

// Modifiers не имеют restaurant_id напрямую — фильтруем через group_id.
// Альтернатива: ходить через JOIN modifier_groups, но проще передавать group_id
// и доверять что Manager-UI не подставит чужой.
func (s *ModifiersService) List(ctx context.Context, groupID string) ([]models.Modifier, error) {
	if groupID == "" {
		return nil, apperrors.Wrap("VALIDATION", "group_id is required", nil)
	}
	// Проверяем что group_id принадлежит ресторану через ForTenant.
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var g models.ModifierGroup
	if err := scoped.Where("id = ?", groupID).First(&g).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	// Теперь читаем modifiers без скоупа (group уже tenant-validated).
	freshRaw := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	var rows []models.Modifier
	if err := freshRaw.Where("group_id = ?", groupID).
		Order("sort_order ASC, name ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *ModifiersService) Create(ctx context.Context, in ModifierInput) (*models.Modifier, error) {
	if in.GroupID == nil || *in.GroupID == "" {
		return nil, apperrors.Wrap("VALIDATION", "group_id is required", nil)
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	// Tenant check: group_id принадлежит ресторану?
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var g models.ModifierGroup
	if err := scoped.Where("id = ?", *in.GroupID).First(&g).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "modifier group not found in this restaurant", nil)
		}
		return nil, err
	}
	now := time.Now().UTC()
	m := &models.Modifier{
		ID: uuid.NewString(), GroupID: in.GroupID, Name: in.Name,
		IsDefault: in.IsDefault, SortOrder: in.SortOrder, CreatedAt: now,
	}
	if in.Price != nil {
		d, err := decimal.FromString(*in.Price)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad price", err)
		}
		m.Price = d
	}
	freshRaw := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	if err := freshRaw.Create(m).Error; err != nil {
		return nil, err
	}
	return m, nil
}

func (s *ModifiersService) Patch(ctx context.Context, id string, in ModifierInput) (*models.Modifier, error) {
	// Изоляция: грузим modifier → group → проверяем tenant.
	freshRaw := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	var m models.Modifier
	if err := freshRaw.Where("id = ?", id).First(&m).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if m.GroupID == nil {
		return nil, apperrors.ErrNotFound
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var g models.ModifierGroup
	if err := scoped.Where("id = ?", *m.GroupID).First(&g).Error; err != nil {
		return nil, apperrors.ErrNotFound // tenant mismatch → not found
	}

	updates := map[string]any{}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.IsDefault != nil {
		updates["is_default"] = *in.IsDefault
	}
	if in.SortOrder != nil {
		updates["sort_order"] = *in.SortOrder
	}
	if in.Price != nil {
		d, err := decimal.FromString(*in.Price)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad price", err)
		}
		updates["price"] = d
	}
	if len(updates) == 0 {
		return &m, nil
	}
	freshRaw2 := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	if err := freshRaw2.Model(&m).Updates(updates).Error; err != nil {
		return nil, err
	}
	freshRaw3 := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	var out models.Modifier
	if err := freshRaw3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *ModifiersService) Delete(ctx context.Context, id string) error {
	// Tenant check через group.
	freshRaw := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	var m models.Modifier
	if err := freshRaw.Where("id = ?", id).First(&m).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.ErrNotFound
		}
		return err
	}
	if m.GroupID != nil {
		scoped, err := s.r.ForTenant(ctx)
		if err != nil {
			return err
		}
		var g models.ModifierGroup
		if err := scoped.Where("id = ?", *m.GroupID).First(&g).Error; err != nil {
			return apperrors.ErrNotFound
		}
	}
	freshRaw2 := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	res := freshRaw2.Where("id = ?", id).Delete(&models.Modifier{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ─── TechCardLines ─────────────────────────────────────────────────────────

type TechCardsService struct{ r *repo.Repo }

func NewTechCardsService(r *repo.Repo) *TechCardsService { return &TechCardsService{r: r} }

type TechCardLineInput struct {
	MenuItemID   *string `json:"menu_item_id,omitempty"`
	IngredientID *string `json:"ingredient_id,omitempty"`
	SemiTypeID   *string `json:"semi_type_id,omitempty"`
	Name         *string `json:"name,omitempty"`
	Qty          *string `json:"qty,omitempty"`
	Unit         *string `json:"unit,omitempty"`
}

// List — все строки тех. карт ресторана. Опц. фильтр по menu_item_id.
func (s *TechCardsService) List(ctx context.Context, menuItemID string) ([]models.TechCardLine, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	q := scoped
	if menuItemID != "" {
		q = q.Where("menu_item_id = ?", menuItemID)
	}
	var rows []models.TechCardLine
	if err := q.Order("menu_item_id, name").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *TechCardsService) Create(ctx context.Context, in TechCardLineInput) (*models.TechCardLine, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.MenuItemID == nil || *in.MenuItemID == "" {
		return nil, apperrors.Wrap("VALIDATION", "menu_item_id is required", nil)
	}
	if in.IngredientID == nil && in.SemiTypeID == nil {
		return nil, apperrors.Wrap("VALIDATION", "ingredient_id or semi_type_id is required", nil)
	}
	now := time.Now().UTC()
	l := &models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: in.MenuItemID,
		IngredientID: in.IngredientID, SemiTypeID: in.SemiTypeID,
		Name: in.Name, Unit: in.Unit,
		RestaurantID: &rid, CreatedAt: now,
	}
	if in.Qty != nil {
		d, err := decimal.FromString(*in.Qty)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad qty", err)
		}
		l.Qty = d
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(l).Error; err != nil {
		return nil, err
	}
	return l, nil
}

func (s *TechCardsService) Patch(ctx context.Context, id string, in TechCardLineInput) (*models.TechCardLine, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.TechCardLine
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{}
	if in.IngredientID != nil {
		updates["ingredient_id"] = *in.IngredientID
	}
	if in.SemiTypeID != nil {
		updates["semi_type_id"] = *in.SemiTypeID
	}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Unit != nil {
		updates["unit"] = *in.Unit
	}
	if in.Qty != nil {
		d, err := decimal.FromString(*in.Qty)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad qty", err)
		}
		updates["qty"] = d
	}
	if len(updates) == 0 {
		return &existing, nil
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.TechCardLine
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *TechCardsService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.TechCardLine{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ═══════════════════════════════════════════════════════════════════════════
// SemiFinished: types + recipe_lines + stock
// ═══════════════════════════════════════════════════════════════════════════

type SemiFinishedService struct{ r *repo.Repo }

func NewSemiFinishedService(r *repo.Repo) *SemiFinishedService { return &SemiFinishedService{r: r} }

type SemiTypeInput struct {
	Name         *string             `json:"name,omitempty"`
	OutputUnit   *string             `json:"output_unit,omitempty"`
	YieldPercent *string             `json:"yield_percent,omitempty"`
	Recipe       *[]SemiRecipeInput  `json:"recipe,omitempty"`
}

// SemiRecipeInput — строка рецепта полуфабриката.
type SemiRecipeInput struct {
	IngredientID *string `json:"ingredient_id,omitempty"`
	Name         *string `json:"name,omitempty"`
	QtyPerUnit   *string `json:"qty_per_unit,omitempty"`
	Unit         *string `json:"unit,omitempty"`
}

// SemiTypeWithRecipe — DTO для GET ?include=recipe.
type SemiTypeWithRecipe struct {
	*models.SemiFinishedType
	Recipe []models.SemiRecipeLine `json:"recipe"`
}

func (s *SemiFinishedService) ListTypes(ctx context.Context) ([]models.SemiFinishedType, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.SemiFinishedType
	if err := scoped.Order("name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ListTypesWithRecipe — types + lines в одном батче (для ?include=recipe).
func (s *SemiFinishedService) ListTypesWithRecipe(ctx context.Context) ([]SemiTypeWithRecipe, error) {
	rows, err := s.ListTypes(ctx)
	if err != nil {
		return nil, err
	}
	if len(rows) == 0 {
		return []SemiTypeWithRecipe{}, nil
	}
	ids := make([]string, 0, len(rows))
	for i := range rows {
		ids = append(ids, rows[i].ID)
	}
	var lines []models.SemiRecipeLine
	if err := s.r.Raw().WithContext(ctx).
		Where("semi_type_id IN ?", ids).Find(&lines).Error; err != nil {
		return nil, err
	}
	byType := make(map[string][]models.SemiRecipeLine, len(rows))
	for _, l := range lines {
		if l.SemiTypeID == nil {
			continue
		}
		byType[*l.SemiTypeID] = append(byType[*l.SemiTypeID], l)
	}
	out := make([]SemiTypeWithRecipe, len(rows))
	for i := range rows {
		r := rows[i]
		ls := byType[r.ID]
		if ls == nil {
			ls = []models.SemiRecipeLine{}
		}
		out[i] = SemiTypeWithRecipe{SemiFinishedType: &r, Recipe: ls}
	}
	return out, nil
}

// GetType — одна запись + опц. recipe.
func (s *SemiFinishedService) GetType(ctx context.Context, id string, includeRecipe bool) (any, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var t models.SemiFinishedType
	if err := scoped.Where("id = ?", id).First(&t).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if !includeRecipe {
		return &t, nil
	}
	var lines []models.SemiRecipeLine
	if err := s.r.Raw().WithContext(ctx).
		Where("semi_type_id = ?", id).Find(&lines).Error; err != nil {
		return nil, err
	}
	if lines == nil {
		lines = []models.SemiRecipeLine{}
	}
	return &SemiTypeWithRecipe{SemiFinishedType: &t, Recipe: lines}, nil
}

func (s *SemiFinishedService) CreateType(ctx context.Context, in SemiTypeInput) (*models.SemiFinishedType, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	t := &models.SemiFinishedType{
		ID: uuid.NewString(), Name: in.Name, OutputUnit: in.OutputUnit,
		RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	if in.YieldPercent != nil {
		d, err := decimal.FromString(*in.YieldPercent)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad yield_percent", err)
		}
		t.YieldPercent = d
	}
	// Recipe — опционально. Транзакция type+lines, чтобы не остался полу-созданный.
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Create(t).Error; err != nil {
			return err
		}
		if in.Recipe != nil {
			for _, r := range *in.Recipe {
				line, err := buildSemiRecipeLine(t.ID, r, now)
				if err != nil {
					return err
				}
				if err := tx.Create(line).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return t, nil
}

// buildSemiRecipeLine — собирает SemiRecipeLine из input.
func buildSemiRecipeLine(semiTypeID string, in SemiRecipeInput, now time.Time) (*models.SemiRecipeLine, error) {
	id := semiTypeID
	l := &models.SemiRecipeLine{
		ID: uuid.NewString(), SemiTypeID: &id,
		IngredientID: in.IngredientID, Name: in.Name, Unit: in.Unit,
		CreatedAt: now,
	}
	if in.QtyPerUnit != nil {
		d, err := decimal.FromString(*in.QtyPerUnit)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad qty_per_unit", err)
		}
		l.QtyPerUnit = d
	}
	return l, nil
}

func (s *SemiFinishedService) PatchType(ctx context.Context, id string, in SemiTypeInput) (*models.SemiFinishedType, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.SemiFinishedType
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
	if in.OutputUnit != nil {
		updates["output_unit"] = *in.OutputUnit
	}
	if in.YieldPercent != nil {
		d, err := decimal.FromString(*in.YieldPercent)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad yield_percent", err)
		}
		updates["yield_percent"] = d
	}
	now := time.Now().UTC()
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Model(&existing).Updates(updates).Error; err != nil {
			return err
		}
		// Полная замена recipe, если передан.
		if in.Recipe != nil {
			if err := tx.Where("semi_type_id = ?", id).Delete(&models.SemiRecipeLine{}).Error; err != nil {
				return err
			}
			for _, r := range *in.Recipe {
				line, err := buildSemiRecipeLine(id, r, now)
				if err != nil {
					return err
				}
				if err := tx.Create(line).Error; err != nil {
					return err
				}
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.SemiFinishedType
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *SemiFinishedService) DeleteType(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.SemiFinishedType{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// Stock — текущие остатки полуфабрикатов (read-only, обновляется через
// produce-flow в Phase 9+).
func (s *SemiFinishedService) ListStock(ctx context.Context) ([]models.SemiFinishedStock, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.SemiFinishedStock
	if err := scoped.Order("name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}
