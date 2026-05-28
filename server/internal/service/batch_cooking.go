package service

import (
	"context"
	"errors"
	"math"
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
	"github.com/restos/restos-v4/server/internal/repo"
)

// BatchCookingService — управление партионной готовкой (batch cooking).
//
// Идея: для blocked items (плов, бэлэш и т.п.) повар готовит сразу N порций,
// ингредиенты списываются один раз (на produce); при заказе из этой партии
// `prepared_qty` декрементится без повторного списания ингредиентов.
type BatchCookingService struct{ r *repo.Repo }

func NewBatchCookingService(r *repo.Repo) *BatchCookingService { return &BatchCookingService{r: r} }

// ─── max-portions ──────────────────────────────────────────────────────────

// BatchBlocker — недостающий ингредиент.
type BatchBlocker struct {
	IngredientID string          `json:"ingredient_id"`
	Name         string          `json:"name"`
	Have         decimal.Decimal `json:"have"`
	Need         decimal.Decimal `json:"need"`
}

// MaxPortionsResult — что отдаём.
type MaxPortionsResult struct {
	Max      int            `json:"max"`
	Blockers []BatchBlocker `json:"blockers"`
}

// MaxPortions — GET /api/v1/menu/items/{id}/max-portions.
//
// Считает сколько порций можно приготовить ПРЯМО СЕЙЧАС, учитывая текущий
// остаток ингредиентов и тех. карту. Возвращает min по всем ингредиентам.
//
// blockers — список ингредиентов, у которых текущего qty не хватит даже на
// одну порцию (have < need).
func (s *BatchCookingService) MaxPortions(ctx context.Context, menuItemID string) (*MaxPortionsResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	// menu_item exists & принадлежит ресторану.
	var mi models.MenuItem
	if err := scoped.Where("id = ?", menuItemID).First(&mi).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}

	// tech_card_lines + ingredients.
	var lines []models.TechCardLine
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND menu_item_id = ?", rid, menuItemID).
		Find(&lines).Error; err != nil {
		return nil, err
	}
	if len(lines) == 0 {
		// Без рецепта max = бесконечность; вернём большой sentinel.
		return &MaxPortionsResult{Max: math.MaxInt32}, nil
	}

	ingIDs := make([]string, 0, len(lines))
	for _, l := range lines {
		if l.IngredientID != nil {
			ingIDs = append(ingIDs, *l.IngredientID)
		}
	}
	var ings []models.Ingredient
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND id IN ?", rid, ingIDs).
		Find(&ings).Error; err != nil {
		return nil, err
	}
	ingByID := make(map[string]models.Ingredient, len(ings))
	for _, i := range ings {
		ingByID[i.ID] = i
	}

	maxPortions := math.MaxInt32
	out := &MaxPortionsResult{}
	for _, l := range lines {
		if l.IngredientID == nil || l.Qty.IsZero() {
			continue
		}
		ing, ok := ingByID[*l.IngredientID]
		if !ok {
			continue
		}
		// have / need_per_portion → floor.
		var possible int
		ratio := decimal.DivRound(ing.Qty, l.Qty).IntPart()
		if ratio > math.MaxInt32 {
			possible = math.MaxInt32
		} else {
			possible = int(ratio)
		}
		if possible < 1 {
			name := ""
			if ing.Name != nil {
				name = *ing.Name
			}
			out.Blockers = append(out.Blockers, BatchBlocker{
				IngredientID: ing.ID,
				Name:         name,
				Have:         ing.Qty,
				Need:         l.Qty,
			})
		}
		if possible < maxPortions {
			maxPortions = possible
		}
	}
	if maxPortions < 0 {
		maxPortions = 0
	}
	out.Max = maxPortions
	return out, nil
}

// ─── produce / decrement / writeoff ────────────────────────────────────────

// BatchProduceInput — body POST /api/v1/menu/items/{id}/batch/produce.
type BatchProduceInput struct {
	Qty        int     `json:"qty"`
	PreparedBy *string `json:"prepared_by,omitempty"`
}

// Produce — атомарно списывает ингредиенты на N порций и увеличивает
// prepared_qty. Пишет BatchCookingLog (type='produce').
func (s *BatchCookingService) Produce(ctx context.Context, menuItemID string, in BatchProduceInput) (*models.MenuItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Qty <= 0 {
		return nil, apperrors.Wrap("VALIDATION", "qty must be > 0", nil)
	}
	actor, _ := audit.ActorFromContext(ctx)

	var out *models.MenuItem
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		var mi models.MenuItem
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, menuItemID).
			First(&mi).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}

		// Списываем ингредиенты по tech_card × qty.
		var lines []models.TechCardLine
		if err := tx.Where("restaurant_id = ? AND menu_item_id = ?", rid, menuItemID).
			Find(&lines).Error; err != nil {
			return err
		}
		now := time.Now().UTC()
		desc := "batch_produce:" + menuItemID
		mvType := "batch_out"
		qtyDec := decimal.FromInt(int64(in.Qty))
		for _, l := range lines {
			if l.IngredientID == nil {
				continue
			}
			deduct := decimal.Normalize(decimal.Mul(l.Qty, qtyDec)).Neg()
			ingID := *l.IngredientID
			unit := l.Unit
			mv := &models.StockMovement{
				ID:             uuid.NewString(),
				Type:           &mvType,
				IngredientID:   &ingID,
				IngredientName: l.Name,
				Description:    &desc,
				Qty:            deduct,
				Unit:           unit,
				RestaurantID:   &rid,
				CreatedAt:      now,
			}
			if err := tx.Create(mv).Error; err != nil {
				return err
			}
		}

		// prepared_qty += qty.
		newPrepared := in.Qty
		if mi.PreparedQty != nil {
			newPrepared = *mi.PreparedQty + in.Qty
		}
		mi.PreparedQty = &newPrepared
		mi.UpdatedAt = now
		if err := tx.Save(&mi).Error; err != nil {
			return err
		}

		// BatchCookingLog.
		logQty := in.Qty
		logType := "produce"
		logReason := logType
		preparedBy := actor.UserName
		if in.PreparedBy != nil {
			preparedBy = *in.PreparedBy
		}
		preparedByID := actor.UserID
		mid := menuItemID
		log := &models.BatchCookingLog{
			ID:           uuid.NewString(),
			MenuItemID:   &mid,
			MenuItemName: mi.Name,
			Qty:          &logQty,
			ProducedBy:   &preparedBy,
			ProducedByID: &preparedByID,
			Reason:       &logReason,
			RestaurantID: &rid,
			CreatedAt:    now,
		}
		if err := tx.Create(log).Error; err != nil {
			return err
		}
		out = &mi
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// BatchDecrementInput — body POST /api/v1/menu/items/{id}/batch/decrement.
type BatchDecrementInput struct {
	Qty     *int    `json:"qty,omitempty"`
	OrderID *string `json:"order_id,omitempty"`
}

// Decrement — уменьшает prepared_qty (при выдаче из партии). Без списания
// ингредиентов — они уже списаны на produce. Пишет BatchCookingLog type='consume'.
func (s *BatchCookingService) Decrement(ctx context.Context, menuItemID string, in BatchDecrementInput) (*models.MenuItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	qty := 1
	if in.Qty != nil {
		qty = *in.Qty
	}
	if qty <= 0 {
		return nil, apperrors.Wrap("VALIDATION", "qty must be > 0", nil)
	}
	return s.adjustPrepared(ctx, rid, menuItemID, -qty, "consume")
}

// BatchWriteoffInput — body POST /api/v1/menu/items/{id}/batch/writeoff.
type BatchWriteoffInput struct {
	Qty    *int    `json:"qty,omitempty"`
	Reason *string `json:"reason,omitempty"`
}

// Writeoff — списывает партию. Если qty не задан — списывает всё prepared_qty.
// Ингредиенты НЕ возвращаются. Пишет BatchCookingLog type='writeoff'.
func (s *BatchCookingService) Writeoff(ctx context.Context, menuItemID string, in BatchWriteoffInput) (*models.MenuItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	reason := "writeoff"
	if in.Reason != nil && *in.Reason != "" {
		reason = *in.Reason
	}
	// Если qty не передан — спишем всё. Подгрузим текущее prepared_qty.
	scoped, _ := s.r.ForTenant(ctx)
	var mi models.MenuItem
	if err := scoped.Where("id = ?", menuItemID).First(&mi).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	q := 0
	if mi.PreparedQty != nil {
		q = *mi.PreparedQty
	}
	if in.Qty != nil {
		q = *in.Qty
	}
	if q <= 0 {
		// Уже 0 — no-op, возвращаем как есть.
		return &mi, nil
	}
	return s.adjustPrepared(ctx, rid, menuItemID, -q, reason)
}

// adjustPrepared — общий helper: меняет prepared_qty на delta, пишет BatchCookingLog.
// delta < 0 — списывает (consume/writeoff). cap at 0.
func (s *BatchCookingService) adjustPrepared(ctx context.Context, rid, menuItemID string, delta int, logType string) (*models.MenuItem, error) {
	actor, _ := audit.ActorFromContext(ctx)
	var out *models.MenuItem
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var mi models.MenuItem
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, menuItemID).
			First(&mi).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		cur := 0
		if mi.PreparedQty != nil {
			cur = *mi.PreparedQty
		}
		newQty := cur + delta
		if newQty < 0 {
			newQty = 0
		}
		now := time.Now().UTC()
		mi.PreparedQty = &newQty
		mi.UpdatedAt = now
		if err := tx.Save(&mi).Error; err != nil {
			return err
		}

		logQty := -delta // qty в логе — абсолютная величина списания
		reason := logType
		preparedBy := actor.UserName
		preparedByID := actor.UserID
		mid := menuItemID
		log := &models.BatchCookingLog{
			ID:           uuid.NewString(),
			MenuItemID:   &mid,
			MenuItemName: mi.Name,
			Qty:          &logQty,
			ProducedBy:   &preparedBy,
			ProducedByID: &preparedByID,
			Reason:       &reason,
			RestaurantID: &rid,
			CreatedAt:    now,
		}
		if err := tx.Create(log).Error; err != nil {
			return err
		}
		out = &mi
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// ─── logs ─────────────────────────────────────────────────────────────────

// Logs — GET /api/v1/menu/items/{id}/batch/logs.
func (s *BatchCookingService) Logs(ctx context.Context, menuItemID string, p cursor.Page) ([]models.BatchCookingLog, string, error) {
	return s.LogsFiltered(ctx, BatchLogsFilter{MenuItemID: menuItemID, Page: p})
}

// BatchLogsFilter — фильтры для cross-item листинга.
type BatchLogsFilter struct {
	MenuItemID string
	From, To   *time.Time
	Page       cursor.Page
}

// LogsFiltered — GET /api/v1/menu/batch/logs (cross-item). menu_item_id опц.
func (s *BatchCookingService) LogsFiltered(ctx context.Context, f BatchLogsFilter) ([]models.BatchCookingLog, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.MenuItemID != "" {
		q = q.Where("menu_item_id = ?", f.MenuItemID)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	q = cursor.Apply(q, "batch_cooking_logs", f.Page)
	var rows []models.BatchCookingLog
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(rows, limit, func(m models.BatchCookingLog) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}
