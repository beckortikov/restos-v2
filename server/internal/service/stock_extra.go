// stock_extra — Phase 11: Ingredients CRUD (без qty), список receipts/writeoffs/
// movements/categories, инвентаризация read, supply_expenses, confirm receipt.
//
// Все мутации идут через GORM-хуки на StockMovement → ingredients.qty.
// Прямой UPDATE qty запрещён.
package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ═══════════════════════════════════════════════════════════════════════════
// Ingredients write CRUD
// ═══════════════════════════════════════════════════════════════════════════

type IngredientsWriteService struct{ r *repo.Repo }

func NewIngredientsWriteService(r *repo.Repo) *IngredientsWriteService {
	return &IngredientsWriteService{r: r}
}

type IngredientInput struct {
	Name         *string `json:"name,omitempty"`
	Category     *string `json:"category,omitempty"`
	Qty          *string `json:"qty,omitempty"`
	MinQty       *string `json:"min_qty,omitempty"`
	Unit         *string `json:"unit,omitempty"`
	PricePerUnit *string `json:"price_per_unit,omitempty"`
	WastePercent *string `json:"waste_percent,omitempty"`
	IsFood       *bool   `json:"is_food,omitempty"`
}

// Create — POST /api/v1/stock/ingredients.
// Если qty > 0 — создаём дополнительно StockMovement (type=in) в той же tx,
// хук обновит ingredients.qty. Сам ингредиент сохраняется с qty=0.
func (s *IngredientsWriteService) Create(ctx context.Context, in IngredientInput) (*models.Ingredient, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	ing := &models.Ingredient{
		ID: uuid.NewString(), Name: in.Name, Category: in.Category, Unit: in.Unit,
		IsFood: in.IsFood, RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	if in.MinQty != nil {
		d, err := decimal.FromString(*in.MinQty)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad min_qty", err)
		}
		ing.MinQty = d
	}
	if in.PricePerUnit != nil {
		d, err := decimal.FromString(*in.PricePerUnit)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad price_per_unit", err)
		}
		ing.PricePerUnit = d
	}
	if in.WastePercent != nil {
		d, err := decimal.FromString(*in.WastePercent)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad waste_percent", err)
		}
		ing.WastePercent = d
	}

	// Парсим initial qty заранее.
	var initialQty decimal.Decimal
	hasInitial := false
	if in.Qty != nil && *in.Qty != "" {
		d, err := decimal.FromString(*in.Qty)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad qty", err)
		}
		if decimal.IsPositive(d) {
			initialQty = d
			hasInitial = true
		}
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Create(ing).Error; err != nil {
			return err
		}
		if hasInitial {
			mvType := "receipt"
			desc := "ingredient_initial:" + ing.ID
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &mvType,
				IngredientID:   &ing.ID,
				IngredientName: ing.Name,
				Description:    &desc,
				Qty:            initialQty,
				Unit:           ing.Unit,
				RestaurantID:   &rid,
				CreatedAt:      time.Now().UTC(),
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	// Подгружаем актуальный qty (если был initial — хук уже его обновил).
	scoped, _ := s.r.ForTenant(ctx)
	var out models.Ingredient
	if err := scoped.Where("id = ?", ing.ID).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// Patch — PATCH /api/v1/stock/ingredients/{id}. qty НЕ принимается тут.
func (s *IngredientsWriteService) Patch(ctx context.Context, id string, in IngredientInput) (*models.Ingredient, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Ingredient
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if in.Qty != nil {
		return nil, apperrors.Wrap("VALIDATION", "qty cannot be updated directly; use stock movements (receipt/writeoff/inventory)", nil)
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Category != nil {
		updates["category"] = *in.Category
	}
	if in.Unit != nil {
		updates["unit"] = *in.Unit
	}
	if in.IsFood != nil {
		updates["is_food"] = *in.IsFood
	}
	if in.MinQty != nil {
		d, err := decimal.FromString(*in.MinQty)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad min_qty", err)
		}
		updates["min_qty"] = d
	}
	if in.PricePerUnit != nil {
		d, err := decimal.FromString(*in.PricePerUnit)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad price_per_unit", err)
		}
		updates["price_per_unit"] = d
	}
	if in.WastePercent != nil {
		d, err := decimal.FromString(*in.WastePercent)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad waste_percent", err)
		}
		updates["waste_percent"] = d
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.Ingredient
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete — DELETE /api/v1/stock/ingredients/{id}.
// Soft-delete нет, FK-check вручную: если есть tech_card_lines → 409.
func (s *IngredientsWriteService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	var existing models.Ingredient
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.ErrNotFound
		}
		return err
	}
	// Check usage in tech_card_lines.
	scopedCheck, _ := s.r.ForTenant(ctx)
	var refs int64
	if err := scopedCheck.Model(&models.TechCardLine{}).
		Where("ingredient_id = ?", id).Count(&refs).Error; err != nil {
		return err
	}
	if refs > 0 {
		return apperrors.Wrap("CONFLICT", "ingredient is in use by tech cards", nil)
	}
	scopedDel, _ := s.r.ForTenant(ctx)
	res := scopedDel.Where("id = ?", id).Delete(&models.Ingredient{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Stock reads: receipts list, writeoffs list, movements list, categories
// ═══════════════════════════════════════════════════════════════════════════

// StockReadsService — read-only листы для приёмок, списаний, движений и категорий.
type StockReadsService struct{ r *repo.Repo }

func NewStockReadsService(r *repo.Repo) *StockReadsService { return &StockReadsService{r: r} }

type ReceiptsFilter struct {
	SupplierID   string
	From, To     *time.Time
	Page         cursor.Page
	IncludeLines bool
}

// ReceiptWithLines — DTO для GET /stock/receipts?include=lines.
type ReceiptWithLines struct {
	*models.StockReceipt
	Lines []models.StockReceiptLine `json:"lines"`
}

// WriteoffWithLines — аналог для writeoffs.
type WriteoffWithLines struct {
	*models.StockWriteoff
	Lines []models.StockWriteoffLine `json:"lines"`
}

func (s *StockReadsService) ListReceipts(ctx context.Context, f ReceiptsFilter) ([]models.StockReceipt, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.SupplierID != "" {
		q = q.Where("supplier_id = ?", f.SupplierID)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	q = cursor.Apply(q, "stock_receipts", f.Page)
	var rows []models.StockReceipt
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.StockReceipt) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

// ListReceiptsWithLines — то же что ListReceipts, но добавляет lines к каждой
// записи через один батч-SELECT по receipt_id IN (...).
func (s *StockReadsService) ListReceiptsWithLines(ctx context.Context, f ReceiptsFilter) ([]ReceiptWithLines, string, error) {
	rows, next, err := s.ListReceipts(ctx, f)
	if err != nil {
		return nil, "", err
	}
	if len(rows) == 0 {
		return []ReceiptWithLines{}, next, nil
	}
	ids := make([]string, 0, len(rows))
	for i := range rows {
		ids = append(ids, rows[i].ID)
	}
	// stock_receipt_lines не имеет restaurant_id; receipt_id IN ids (отскоупленные)
	// — единственный безопасный фильтр.
	var lines []models.StockReceiptLine
	if err := s.r.Raw().WithContext(ctx).
		Where("receipt_id IN ?", ids).Find(&lines).Error; err != nil {
		return nil, "", err
	}
	byReceipt := make(map[string][]models.StockReceiptLine, len(rows))
	for _, l := range lines {
		if l.ReceiptID == nil {
			continue
		}
		byReceipt[*l.ReceiptID] = append(byReceipt[*l.ReceiptID], l)
	}
	out := make([]ReceiptWithLines, len(rows))
	for i := range rows {
		r := rows[i]
		ls := byReceipt[r.ID]
		if ls == nil {
			ls = []models.StockReceiptLine{}
		}
		out[i] = ReceiptWithLines{StockReceipt: &r, Lines: ls}
	}
	return out, next, nil
}

type WriteoffsFilter struct {
	From, To     *time.Time
	Page         cursor.Page
	IncludeLines bool
}

func (s *StockReadsService) ListWriteoffs(ctx context.Context, f WriteoffsFilter) ([]models.StockWriteoff, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	q = cursor.Apply(q, "stock_writeoffs", f.Page)
	var rows []models.StockWriteoff
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.StockWriteoff) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

// ListWriteoffsWithLines — то же что ListWriteoffs, но с lines.
func (s *StockReadsService) ListWriteoffsWithLines(ctx context.Context, f WriteoffsFilter) ([]WriteoffWithLines, string, error) {
	rows, next, err := s.ListWriteoffs(ctx, f)
	if err != nil {
		return nil, "", err
	}
	if len(rows) == 0 {
		return []WriteoffWithLines{}, next, nil
	}
	ids := make([]string, 0, len(rows))
	for i := range rows {
		ids = append(ids, rows[i].ID)
	}
	var lines []models.StockWriteoffLine
	if err := s.r.Raw().WithContext(ctx).
		Where("writeoff_id IN ?", ids).Find(&lines).Error; err != nil {
		return nil, "", err
	}
	byID := make(map[string][]models.StockWriteoffLine, len(rows))
	for _, l := range lines {
		if l.WriteoffID == nil {
			continue
		}
		byID[*l.WriteoffID] = append(byID[*l.WriteoffID], l)
	}
	out := make([]WriteoffWithLines, len(rows))
	for i := range rows {
		r := rows[i]
		ls := byID[r.ID]
		if ls == nil {
			ls = []models.StockWriteoffLine{}
		}
		out[i] = WriteoffWithLines{StockWriteoff: &r, Lines: ls}
	}
	return out, next, nil
}

type MovementsFilter struct {
	IngredientID string
	Type         string
	From, To     *time.Time
	Page         cursor.Page
}

func (s *StockReadsService) ListMovements(ctx context.Context, f MovementsFilter) ([]models.StockMovement, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.IngredientID != "" {
		q = q.Where("ingredient_id = ?", f.IngredientID)
	}
	if f.Type != "" {
		q = q.Where("type = ?", f.Type)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	q = cursor.Apply(q, "stock_movements", f.Page)
	var rows []models.StockMovement
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.StockMovement) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

// ListCategories — distinct ingredient.category, отсортировано.
func (s *StockReadsService) ListCategories(ctx context.Context) ([]string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []string
	if err := scoped.Model(&models.Ingredient{}).
		Distinct("category").
		Where("category IS NOT NULL AND category <> ''").
		Order("category ASC").
		Pluck("category", &rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Receipt confirm
// ═══════════════════════════════════════════════════════════════════════════

type ConfirmReceiptInput struct {
	AccountID   *string `json:"account_id,omitempty"`
	PaymentType *string `json:"payment_type,omitempty"`
}

// ConfirmReceipt — POST /api/v1/stock/receipts/{id}/confirm.
//
// - Если payment_type == "credit" и есть supplier — создаёт Liability на сумму долга.
// - Если account_id указан — создаёт FinancialOperation (type=expense, category=stock_receipt).
// - Обновляет confirmed_at/by если ещё нет, и сохраняет payment_type.
func (s *StockService) ConfirmReceipt(ctx context.Context, id string, in ConfirmReceiptInput) (*models.StockReceipt, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()

	var result *models.StockReceipt
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var receipt models.StockReceipt
		if err := tx.Where("restaurant_id = ? AND id = ?", rid, id).First(&receipt).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		updates := map[string]any{"updated_at": now}
		if in.PaymentType != nil && *in.PaymentType != "" {
			updates["payment_type"] = *in.PaymentType
			if *in.PaymentType == "paid" {
				updates["paid_amount"] = receipt.TotalAmount
				updates["debt_amount"] = decimal.Zero
			}
		}
		if receipt.ConfirmedAt == nil {
			updates["confirmed_at"] = now
			updates["confirmed_by"] = actor.UserID
		}
		if err := tx.Model(&receipt).Updates(updates).Error; err != nil {
			return err
		}
		// Эффективный payment_type для side-effects.
		effPT := ""
		if in.PaymentType != nil {
			effPT = *in.PaymentType
		} else if receipt.PaymentType != nil {
			effPT = *receipt.PaymentType
		}

		// Liability для credit.
		if effPT == "credit" && decimal.IsPositive(receipt.TotalAmount) {
			name := "Долг поставщику"
			if receipt.SupplierName != nil && *receipt.SupplierName != "" {
				name = "Долг: " + *receipt.SupplierName
			}
			category := "supplier_debt"
			ridStr := rid
			ref := "stock_receipt:" + receipt.ID
			lia := &models.Liability{
				ID:              uuid.NewString(),
				Name:            &name,
				Category:        &category,
				TotalAmount:     receipt.TotalAmount,
				PaidAmount:      decimal.Zero,
				RemainingAmount: receipt.TotalAmount,
				Creditor:        receipt.SupplierName,
				DueDate:         receipt.DueDate,
				Note:            &ref,
				RestaurantID:    &ridStr,
				CreatedAt:       now,
				UpdatedAt:       now,
			}
			if err := tx.Create(lia).Error; err != nil {
				return err
			}
		}

		// FinancialOperation если account_id указан (оплачено наличкой/со счёта).
		if in.AccountID != nil && *in.AccountID != "" && decimal.IsPositive(receipt.TotalAmount) {
			opType := "expense"
			category := "stock_receipt"
			activity := "operational"
			date := now.Format("2006-01-02")
			desc := "stock_receipt:" + receipt.ID
			ridStr := rid
			accID := *in.AccountID
			isAuto := true
			op := &models.FinancialOperation{
				ID:           uuid.NewString(),
				Type:         &opType,
				Amount:       receipt.TotalAmount,
				Category:     &category,
				AccountID:    &accID,
				Activity:     &activity,
				Date:         &date,
				Description:  &desc,
				Counterparty: receipt.SupplierName,
				IsAuto:       &isAuto,
				SourceRef:    &desc,
				RestaurantID: &ridStr,
				CreatedAt:    now,
				UpdatedAt:    now,
			}
			if err := tx.Create(op).Error; err != nil {
				return err
			}
		}

		// Reload.
		var refreshed models.StockReceipt
		if err := tx.Where("id = ?", id).First(&refreshed).Error; err != nil {
			return err
		}
		result = &refreshed
		return nil
	})
	if err != nil {
		return nil, err
	}
	return result, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// Inventory reads
// ═══════════════════════════════════════════════════════════════════════════

type InventoryReadsService struct{ r *repo.Repo }

func NewInventoryReadsService(r *repo.Repo) *InventoryReadsService {
	return &InventoryReadsService{r: r}
}

type InventoryListFilter struct {
	Status string
	Page   cursor.Page
}

func (s *InventoryReadsService) List(ctx context.Context, f InventoryListFilter) ([]models.InventoryCheck, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	q = cursor.Apply(q, "inventory_checks", f.Page)
	var rows []models.InventoryCheck
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.InventoryCheck) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

// Get — одна инвентаризация (без линий).
func (s *InventoryReadsService) Get(ctx context.Context, id string) (*models.InventoryCheck, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var check models.InventoryCheck
	if err := scoped.Where("id = ?", id).First(&check).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &check, nil
}

// ListLines — все строки одного inventory_check.
func (s *InventoryReadsService) ListLines(ctx context.Context, checkID string) ([]models.InventoryCheckLine, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	// Сначала проверяем, что check принадлежит tenant'у.
	var check models.InventoryCheck
	if err := scoped.Where("id = ?", checkID).First(&check).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	scoped2, _ := s.r.ForTenant(ctx)
	var lines []models.InventoryCheckLine
	if err := scoped2.Where("check_id = ?", checkID).
		Order("ingredient_name ASC").
		Find(&lines).Error; err != nil {
		return nil, err
	}
	return lines, nil
}

// ═══════════════════════════════════════════════════════════════════════════
// SupplyExpense — хоз. выдача со склада (списание не-food через StockMovement).
// ═══════════════════════════════════════════════════════════════════════════

type SupplyExpensesService struct{ r *repo.Repo }

func NewSupplyExpensesService(r *repo.Repo) *SupplyExpensesService {
	return &SupplyExpensesService{r: r}
}

type SupplyExpenseInput struct {
	IngredientID *string `json:"ingredient_id,omitempty"`
	Qty          *string `json:"qty,omitempty"`
	Unit         *string `json:"unit,omitempty"`
	Reason       *string `json:"reason,omitempty"`
	IssuedTo     *string `json:"issued_to,omitempty"`
	Note         *string `json:"note,omitempty"`
}

type SupplyExpensesFilter struct {
	IngredientID string
	From, To     *time.Time
	Page         cursor.Page
}

func (s *SupplyExpensesService) List(ctx context.Context, f SupplyExpensesFilter) ([]models.SupplyExpense, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.IngredientID != "" {
		q = q.Where("ingredient_id = ?", f.IngredientID)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	q = cursor.Apply(q, "supply_expenses", f.Page)
	var rows []models.SupplyExpense
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.SupplyExpense) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

// Create — POST /api/v1/supply-expenses. Создаёт запись и StockMovement -qty.
func (s *SupplyExpensesService) Create(ctx context.Context, in SupplyExpenseInput) (*models.SupplyExpense, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.IngredientID == nil || *in.IngredientID == "" {
		return nil, apperrors.Wrap("VALIDATION", "ingredient_id is required", nil)
	}
	if in.Qty == nil || *in.Qty == "" {
		return nil, apperrors.Wrap("VALIDATION", "qty is required", nil)
	}
	qty, err := decimal.FromString(*in.Qty)
	if err != nil || !decimal.IsPositive(qty) {
		return nil, apperrors.Wrap("VALIDATION", "bad qty", err)
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()

	// Load ingredient (tenant check).
	scopedRead, _ := s.r.ForTenant(ctx)
	var ing models.Ingredient
	if err := scopedRead.Where("id = ?", *in.IngredientID).First(&ing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "ingredient not found", nil)
		}
		return nil, err
	}
	ingName := ""
	if ing.Name != nil {
		ingName = *ing.Name
	}
	unit := in.Unit
	if unit == nil {
		unit = ing.Unit
	}

	exp := &models.SupplyExpense{
		ID:             uuid.NewString(),
		IngredientID:   in.IngredientID,
		IngredientName: &ingName,
		Qty:            qty,
		Unit:           unit,
		Reason:         in.Reason,
		IssuedTo:       in.IssuedTo,
		Note:           in.Note,
		CreatedBy:      &actor.UserID,
		RestaurantID:   &rid,
		CreatedAt:      now,
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Create(exp).Error; err != nil {
			return err
		}
		mvType := "supply_expense"
		desc := "supply_expense:" + exp.ID
		mv := &models.StockMovement{
			ID:             uuid.NewString(),
			Type:           &mvType,
			IngredientID:   in.IngredientID,
			IngredientName: &ingName,
			Description:    &desc,
			Qty:            qty.Neg(),
			Unit:           unit,
			RestaurantID:   &rid,
			CreatedAt:      now,
		}
		return tx.Create(mv).Error
	})
	if err != nil {
		return nil, err
	}
	return exp, nil
}
