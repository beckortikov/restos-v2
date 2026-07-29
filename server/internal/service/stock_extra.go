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

// ═══════════════════════════════════════════════════════════════════════════
// Ingredients write CRUD
// ═══════════════════════════════════════════════════════════════════════════

type IngredientsWriteService struct{ r *repo.Repo }

func NewIngredientsWriteService(r *repo.Repo) *IngredientsWriteService {
	return &IngredientsWriteService{r: r}
}

type IngredientInput struct {
	Name           *string `json:"name,omitempty"`
	Category       *string `json:"category,omitempty"`
	Qty            *string `json:"qty,omitempty"`
	MinQty         *string `json:"min_qty,omitempty"`
	Unit           *string `json:"unit,omitempty"`
	PricePerUnit   *string `json:"price_per_unit,omitempty"`
	WastePercent   *string `json:"waste_percent,omitempty"`
	UnitWeight     *string `json:"unit_weight,omitempty"`      // вес/объём одной складской единицы (per-unit фактор)
	UnitWeightUnit *string `json:"unit_weight_unit,omitempty"` // единица фактора (г/мл)
	IsFood         *bool   `json:"is_food,omitempty"`
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
	if in.UnitWeight != nil {
		d, err := decimal.FromString(*in.UnitWeight)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad unit_weight", err)
		}
		ing.UnitWeight = d
	}
	if in.UnitWeightUnit != nil {
		ing.UnitWeightUnit = in.UnitWeightUnit
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

	isFood := true
	if in.IsFood != nil {
		isFood = *in.IsFood
	}
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Склад по типу товара (мультисклад): новый товар сразу привязан.
		wid, werr := resolveWarehouseID(tx, rid, isFood, false)
		if werr != nil {
			return werr
		}
		ing.WarehouseID = wid
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
				WarehouseID:    ing.WarehouseID,
				RestaurantID:   &rid,
				CreatedAt:      time.Now().UTC(),
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
			// Н10: начальный остаток при создании ингредиента — тот же
			// экономический смысл, что экран «Начальный остаток»: вырос актив
			// «Склад», встречно растёт капитал (взнос собственника). Без этой
			// проводки актив появлялся «из воздуха» и расчётный капитал в Балансе
			// дрейфовал на стоимость остатка. Категория та же (opening_inventory),
			// поэтому оба пути агрегируются в одну строку капитала.
			stockValue := decimal.Normalize(decimal.Mul(initialQty, ing.PricePerUnit))
			if decimal.IsPositive(stockValue) {
				eqName := "Взнос собственника — начальный остаток склада"
				eqCat := "opening_inventory"
				eqNow := time.Now().UTC()
				eq := &models.EquityEntry{
					ID: uuid.NewString(), Name: &eqName, Category: &eqCat,
					Amount: stockValue, RestaurantID: &rid, CreatedAt: eqNow, UpdatedAt: eqNow,
				}
				if err := tx.Create(eq).Error; err != nil {
					return err
				}
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
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	updates := map[string]any{"updated_at": now}
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
	// Эффективная цена для оценки стоимости дельты остатка (новая, если задана).
	effPrice := existing.PricePerUnit
	if in.PricePerUnit != nil {
		d, err := decimal.FromString(*in.PricePerUnit)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad price_per_unit", err)
		}
		updates["price_per_unit"] = d
		effPrice = d
	}
	if in.WastePercent != nil {
		d, err := decimal.FromString(*in.WastePercent)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad waste_percent", err)
		}
		updates["waste_percent"] = d
	}
	if in.UnitWeight != nil {
		d, err := decimal.FromString(*in.UnitWeight)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad unit_weight", err)
		}
		updates["unit_weight"] = d
	}
	if in.UnitWeightUnit != nil {
		updates["unit_weight_unit"] = *in.UnitWeightUnit
	}

	// Остаток правится НЕ прямым UPDATE (CLAUDE.md правило #5), а корректирующим
	// движением на дельту (target − current) → хук денормализует qty. Встречная
	// проводка в капитал «Корректировка остатка» на стоимость дельты держит
	// Баланс сведённым. Повторная правка на то же значение — дельта 0, no-op.
	var qtyDelta *decimal.Decimal
	if in.Qty != nil {
		target, perr := decimal.FromString(*in.Qty)
		if perr != nil || decimal.IsNegative(target) {
			return nil, apperrors.Wrap("VALIDATION", "bad qty", perr)
		}
		d := decimal.Sub(target, existing.Qty)
		qtyDelta = &d
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Model(&models.Ingredient{}).Where("id = ? AND restaurant_id = ?", id, rid).
			Updates(updates).Error; err != nil {
			return err
		}
		if qtyDelta != nil && !qtyDelta.IsZero() {
			mvType := "adjustment"
			desc := "Корректировка остатка (ручная правка)"
			mv := &models.StockMovement{
				ID: uuid.NewString(), Type: &mvType, IngredientID: &id,
				IngredientName: existing.Name, Description: &desc, Qty: *qtyDelta,
				Unit: existing.Unit, RestaurantID: &rid, CreatedAt: now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
			val := decimal.Normalize(decimal.Mul(*qtyDelta, effPrice))
			if !val.IsZero() {
				name := "Корректировка остатка склада"
				cat := "stock_adjustment"
				eq := &models.EquityEntry{
					ID: uuid.NewString(), Name: &name, Category: &cat, Amount: val,
					RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
				}
				if err := tx.Create(eq).Error; err != nil {
					return err
				}
			}
		}
		// Н11: переоценка СТАРОГО остатка при смене цены. Меняя цену 10->100 при
		// 50 шт, актив «Склад» растёт на 50x90=4500 без встречной записи — расчётный
		// капитал в Балансе дрейфовал. Проводим на existing.Qty x (новая - старая);
		// вместе с qty-дельтой (на новой цене) это ровно полный дельта-стоимости.
		if in.PricePerUnit != nil && !effPrice.Equal(existing.PricePerUnit) && decimal.IsPositive(existing.Qty) {
			reval := decimal.Normalize(decimal.Mul(existing.Qty, decimal.Sub(effPrice, existing.PricePerUnit)))
			if !reval.IsZero() {
				rname := "Переоценка остатка склада"
				rcat := "stock_revaluation"
				req := &models.EquityEntry{
					ID: uuid.NewString(), Name: &rname, Category: &rcat, Amount: reval,
					RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
				}
				if err := tx.Create(req).Error; err != nil {
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
	var out models.Ingredient
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// Delete — DELETE /api/v1/stock/ingredients/{id}.
// Soft-delete нет, FK-check вручную: если есть tech_card_lines → 409.
func (s *IngredientsWriteService) Delete(ctx context.Context, id string) error {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
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

	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()
	name := ""
	if existing.Name != nil {
		name = *existing.Name
	}
	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Если есть положительный остаток — списываем его перед удалением, чтобы
		// Баланс сошёлся: склад −V (актив) и встречный убыток −V в ОПиУ (→ капитал).
		// total_cost = qty × price_per_unit. Стоимость снимается в stock_writeoffs
		// (snapshot), поэтому удаление ингредиента после списания безопасно.
		if decimal.IsPositive(existing.Qty) {
			cost := decimal.Normalize(decimal.Mul(existing.Qty, existing.PricePerUnit))
			writeoffID := uuid.NewString()
			creator := actor.UserID
			reason := "Удаление ингредиента"
			w := &models.StockWriteoff{
				ID: writeoffID, Reason: &reason, TotalCost: cost,
				CreatedBy: &creator, RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
			}
			if err := tx.Create(w).Error; err != nil {
				return err
			}
			wl := &models.StockWriteoffLine{
				ID: uuid.NewString(), WriteoffID: &writeoffID, IngredientID: &id,
				Name: &name, Qty: existing.Qty, Unit: existing.Unit, Cost: cost, UpdatedAt: now,
			}
			if err := tx.Create(wl).Error; err != nil {
				return err
			}
			// stock_movement (writeoff, −qty) → хук обнулит ingredients.qty в этой же tx.
			mvType := "writeoff"
			desc := "writeoff:" + writeoffID
			mv := &models.StockMovement{
				ID: uuid.NewString(), Type: &mvType, IngredientID: &id,
				IngredientName: &name, Description: &desc, Qty: existing.Qty.Neg(),
				Unit: existing.Unit, RestaurantID: &rid, CreatedAt: now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
		}
		res := tx.Where("id = ? AND restaurant_id = ?", id, rid).Delete(&models.Ingredient{})
		if res.Error != nil {
			return res.Error
		}
		if res.RowsAffected == 0 {
			return apperrors.ErrNotFound
		}
		return nil
	})
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

// ReceiptLineWithAvailable — строка накладной + сколько по ней ещё можно
// вернуть поставщику, В ЕДИНИЦАХ НАКЛАДНОЙ (в них же клиент вводит количество).
//
// Считает бэк, а не клиент. Диалог возврата считал это сам и ошибался дважды:
// не вычитал отменённые возвраты (после сторно занижал доступное и блокировал
// то, что бэк принимает) и сравнивал остаток склада в единицах СКЛАДА с
// принятым в единицах НАКЛАДНОЙ (накладная в граммах при складе в кг → «20»
// вместо 20000). Плюс ради этого он тянул на клиент весь справочник товаров.
// Правило одно и живёт там же, где guard в CreateReturn.
type ReceiptLineWithAvailable struct {
	models.StockReceiptLine
	Available decimal.Decimal `json:"available_to_return"`
}

// ReceiptWithLines — DTO для GET /stock/receipts?include=lines.
type ReceiptWithLines struct {
	*models.StockReceipt
	Lines []ReceiptLineWithAvailable `json:"lines"`
	// ReturnedTotal — сумма НЕотменённых возвратов поставщику по этой накладной.
	// UI по нему показывает статус «Возвращено» (полный) / «Возврат части»
	// (частичный) вместо статуса оплаты.
	ReturnedTotal decimal.Decimal `json:"returned_total"`
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

	// available_to_return по каждой строке — то же правило, что в guard'е
	// CreateReturn: min(принято − уже возвращённое, фактический остаток).
	avail, err := s.availableToReturn(ctx, lines)
	if err != nil {
		return nil, "", err
	}

	byReceipt := make(map[string][]ReceiptLineWithAvailable, len(rows))
	for _, l := range lines {
		if l.ReceiptID == nil {
			continue
		}
		byReceipt[*l.ReceiptID] = append(byReceipt[*l.ReceiptID],
			ReceiptLineWithAvailable{StockReceiptLine: l, Available: avail[l.ID]})
	}

	// Сумма НЕотменённых возвратов по каждой накладной — для статуса «Возвращено»/
	// «Возврат части» в UI. receipt_id IN ids (отскоупленные) — тот же безопасный
	// tenant-фильтр, что и для строк выше.
	returnedByReceipt := make(map[string]decimal.Decimal, len(rows))
	type retRow struct {
		ReceiptID string          `gorm:"column:receipt_id"`
		Sum       decimal.Decimal `gorm:"column:sum"`
	}
	var retRows []retRow
	if err := s.r.Raw().WithContext(ctx).
		Table("stock_returns").
		Select("receipt_id, COALESCE(SUM(total_amount), 0) AS sum").
		Where("receipt_id IN ? AND cancelled_at IS NULL", ids).
		Group("receipt_id").
		Find(&retRows).Error; err != nil {
		return nil, "", err
	}
	for _, rr := range retRows {
		returnedByReceipt[rr.ReceiptID] = decimal.Normalize(rr.Sum)
	}

	out := make([]ReceiptWithLines, len(rows))
	for i := range rows {
		r := rows[i]
		ls := byReceipt[r.ID]
		if ls == nil {
			ls = []ReceiptLineWithAvailable{}
		}
		out[i] = ReceiptWithLines{StockReceipt: &r, Lines: ls, ReturnedTotal: returnedByReceipt[r.ID]}
	}
	return out, next, nil
}

// availableToReturn — сколько ещё можно вернуть по каждой строке накладной,
// в единицах накладной. Зеркалит guard'ы CreateReturn:
//   - «нельзя вернуть больше, чем пришло»: принято − Σ НЕотменённых возвратов;
//   - «нельзя вернуть то, чего нет на складе»: фактический остаток товара,
//     переведённый из единиц склада в единицы накладной.
//
// Два батч-запроса на всю страницу, без N+1.
func (s *StockReadsService) availableToReturn(ctx context.Context, lines []models.StockReceiptLine) (map[string]decimal.Decimal, error) {
	out := make(map[string]decimal.Decimal, len(lines))
	if len(lines) == 0 {
		return out, nil
	}
	lineIDs := make([]string, 0, len(lines))
	ingIDs := make([]string, 0, len(lines))
	seenIng := make(map[string]struct{})
	for i := range lines {
		lineIDs = append(lineIDs, lines[i].ID)
		if id := deref(lines[i].IngredientID); id != "" {
			if _, ok := seenIng[id]; !ok {
				seenIng[id] = struct{}{}
				ingIDs = append(ingIDs, id)
			}
		}
	}

	// Уже возвращённое (отменённые не считаем — товар по ним приехал назад).
	returned := make(map[string]decimal.Decimal, len(lines))
	var retRows []struct {
		ReceiptLineID string          `gorm:"column:receipt_line_id"`
		Qty           decimal.Decimal `gorm:"column:qty"`
	}
	if err := s.r.Raw().WithContext(ctx).Model(&models.StockReturnLine{}).
		Joins("JOIN stock_returns sr ON sr.id = stock_return_lines.return_id").
		Select("stock_return_lines.receipt_line_id AS receipt_line_id, COALESCE(SUM(stock_return_lines.qty), 0) AS qty").
		Where("stock_return_lines.receipt_line_id IN ?", lineIDs).
		Where("sr.cancelled_at IS NULL").
		Group("stock_return_lines.receipt_line_id").Scan(&retRows).Error; err != nil {
		return nil, err
	}
	for _, r := range retRows {
		returned[r.ReceiptLineID] = r.Qty
	}

	// Остатки товаров — через ForTenant (кросс-ресторанной утечки быть не должно).
	ings := make(map[string]models.Ingredient, len(ingIDs))
	if len(ingIDs) > 0 {
		scoped, err := s.r.ForTenant(ctx)
		if err != nil {
			return nil, err
		}
		var rows []models.Ingredient
		if err := scoped.Where("id IN ?", ingIDs).Find(&rows).Error; err != nil {
			return nil, err
		}
		for _, i := range rows {
			ings[i.ID] = i
		}
	}

	for i := range lines {
		l := lines[i]
		unreturned := decimal.Sub(l.Qty, returned[l.ID])
		if decimal.IsNegative(unreturned) {
			unreturned = decimal.Zero
		}
		res := unreturned
		ing, ok := ings[deref(l.IngredientID)]
		if !ok {
			// Товар удалён из справочника (удаление списывает остаток в убыток).
			// Вернуть его поставщику нельзя — CreateReturn отбивает такую строку,
			// и форма обязана показывать 0, а не всё принятое количество.
			out[l.ID] = decimal.Zero
			continue
		}
		// Остаток склада → в единицы накладной: иначе сравниваем килограммы
		// с граммами (накладная в г при складе в кг занижала доступное в 1000 раз).
		onHand := units.Convert(ing.Qty, deref(ing.Unit), deref(l.Unit))
		if onHand.LessThan(res) {
			res = onHand
		}
		if decimal.IsNegative(res) {
			res = decimal.Zero
		}
		out[l.ID] = decimal.Normalize(res)
	}
	return out, nil
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
	WarehouseID  string
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
	if f.WarehouseID != "" {
		q = q.Where("warehouse_id = ?", f.WarehouseID)
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
	if err := requirePermFor(ctx, s.r, "inventory.manage"); err != nil {
		return nil, err
	}
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

	// Н7: количество для движения — в единице склада (симметрично приёмке).
	// Раньше движение писалось в единице строки: «500 г» при складе в кг
	// денормализовало остаток как −500 кг.
	stockUnit := deref(ing.Unit)
	stockQty := units.Convert(qty, deref(unit), stockUnit)
	mvUnit := unit
	if stockUnit != "" {
		mvUnit = &stockUnit
	}
	// Н8: стоимость фиксируем сейчас = складское_кол-во × текущая цена.
	cost := decimal.Normalize(decimal.Mul(stockQty, ing.PricePerUnit))

	exp := &models.SupplyExpense{
		ID:             uuid.NewString(),
		IngredientID:   in.IngredientID,
		IngredientName: &ingName,
		Qty:            qty,
		Unit:           unit,
		Cost:           cost,
		Reason:         in.Reason,
		IssuedTo:       in.IssuedTo,
		Note:           in.Note,
		CreatedBy:      &actor.UserID,
		RestaurantID:   &rid,
		CreatedAt:      now,
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Флаг ресторана «📦 Хозтовары: разрешить минус». Выключен → выдать
		// больше, чем на складе, нельзя. До v3.16.90 флаг НИГДЕ не читался: он
		// писался в настройках и молча ничего не делал, то есть тумблер обещал
		// владельцу контроль, которого не было. Default true — у тех, кто его не
		// трогал, поведение не меняется; проверка включается только тем, кто
		// осознанно выключил.
		//
		// Читаем остаток под замком в транзакции: без FOR UPDATE две параллельные
		// выдачи прочитают один остаток и обе пройдут проверку.
		var allowNeg bool
		if err := tx.Model(&models.Restaurant{}).
			Select("COALESCE(supply_allow_negative, true)").
			Where("id = ?", rid).Scan(&allowNeg).Error; err != nil {
			return err
		}
		if !allowNeg {
			var locked models.Ingredient
			if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
				Where("restaurant_id = ? AND id = ?", rid, *in.IngredientID).
				First(&locked).Error; err != nil {
				return err
			}
			stockQty := units.Convert(qty, deref(unit), deref(locked.Unit))
			if stockQty.GreaterThan(locked.Qty) {
				return apperrors.Wrap("CONFLICT",
					"на складе недостаточно: "+ingName+", остаток "+locked.Qty.String(), nil)
			}
		}

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
			Qty:            stockQty.Neg(),
			Unit:           mvUnit,
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
