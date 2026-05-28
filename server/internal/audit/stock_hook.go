package audit

import (
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
)

// RegisterStockDenorm цепляет AfterCreate-хук на StockMovement, который
// в той же транзакции обновляет `ingredients.qty` на дельту движения.
//
// Зачем: CLAUDE.md «ingredients.qty — только через event-stream stock_movements,
// не прямой UPDATE». Денормализованное поле qty — для быстрого чтения остатков
// (иначе фронту нужно делать SUM(stock_movements) на каждый рендер).
//
// Источник истины — stock_movements (append-only). qty — производное.
// На пересчёт после катастрофы (испорченные qty) — отдельная job (Phase 4).
//
// Регистрируется один раз в db.Open после audit.Register.
func RegisterStockDenorm(db *gorm.DB) error {
	return db.Callback().Create().After("gorm:create").Register("stock:after_create_movement", stockAfterCreate)
}

func stockAfterCreate(tx *gorm.DB) {
	if tx.Error != nil {
		return
	}
	// Только для stock_movements.
	if tx.Statement.Table != "stock_movements" {
		return
	}
	if tx.DryRun || tx.Statement.Dest == nil {
		return
	}

	movements := extractMovements(tx.Statement.Dest)
	if len(movements) == 0 {
		return
	}

	// Группируем по ingredient_id и накапливаем delta в Go через shopspring/decimal
	// (exact arithmetic, без float). Один UPDATE per ingredient — атомарно на стороне PG.
	//
	// Раньше тут был raw SQL с literal-expression ("qty + (5.5 + -0.2 + 3.0)"). Заменили
	// на gorm.Expr — точность не страдает: shopspring/decimal exact, pgx/v5 передаёт NUMERIC
	// без float-конверсии.
	deltas := make(map[string]decimal.Decimal)
	for _, m := range movements {
		if m.IngredientID == nil || *m.IngredientID == "" {
			continue
		}
		key := *m.IngredientID
		if existing, ok := deltas[key]; ok {
			deltas[key] = decimal.Add(existing, m.Qty)
		} else {
			deltas[key] = m.Qty
		}
	}
	if len(deltas) == 0 {
		return
	}

	// Используем ту же tx-сессию через NewDB+SkipHooks, чтобы не рекурсивно
	// триггерить audit/stock хуки.
	session := tx.Session(&gorm.Session{NewDB: true, SkipHooks: true})
	now := time.Now().UTC()

	// Phase 19: финальный guard. Если enforce_stock_check=true для ресторана —
	// после применения delta qty не должен уйти в минус. Иначе откатываем tx.
	// Группируем по restaurant'у (берём первый ненулевой restaurant_id из movements
	// — обычно все movements в одной tx принадлежат одному ресторану).
	var rid string
	for _, m := range movements {
		if m.RestaurantID != nil && *m.RestaurantID != "" {
			rid = *m.RestaurantID
			break
		}
	}
	strict := false
	if rid != "" {
		var rest models.Restaurant
		if err := session.Select("enforce_stock_check").Where("id = ?", rid).First(&rest).Error; err == nil {
			strict = rest.EnforceStockCheck != nil && *rest.EnforceStockCheck
		}
	}

	for ingID, delta := range deltas {
		if delta.IsZero() {
			continue
		}
		// Если strict — читаем текущий qty, проверяем, что qty+delta >= 0.
		if strict && delta.IsNegative() {
			var ing models.Ingredient
			if err := session.Select("qty").Where("id = ?", ingID).First(&ing).Error; err != nil {
				log.Error().Err(err).Str("ingredient_id", ingID).Msg("stock guard: read failed")
				_ = tx.AddError(err)
				return
			}
			newQty := decimal.Add(ing.Qty, decimal.Normalize(delta))
			if newQty.IsNegative() {
				log.Warn().
					Str("ingredient_id", ingID).
					Str("current", ing.Qty.String()).
					Str("delta", delta.String()).
					Msg("stock guard: would go negative under strict mode")
				_ = tx.AddError(apperrors.Wrap("CONFLICT",
					"insufficient stock for ingredient "+ingID+
						" (current="+ing.Qty.String()+", delta="+decimal.Normalize(delta).String()+")",
					nil))
				return
			}
		}
		res := session.Model(&models.Ingredient{}).
			Where("id = ?", ingID).
			Updates(map[string]any{
				"qty":        gorm.Expr("qty + ?", decimal.Normalize(delta)),
				"updated_at": now,
			})
		if res.Error != nil {
			log.Error().Err(res.Error).Str("ingredient_id", ingID).Msg("stock denorm update failed")
		}
	}
}

// extractMovements достаёт []StockMovement из tx.Statement.Dest, который
// может быть *StockMovement, []StockMovement, *[]StockMovement.
func extractMovements(dest any) []*models.StockMovement {
	switch v := dest.(type) {
	case *models.StockMovement:
		if v == nil {
			return nil
		}
		return []*models.StockMovement{v}
	case []*models.StockMovement:
		return v
	case []models.StockMovement:
		out := make([]*models.StockMovement, len(v))
		for i := range v {
			out[i] = &v[i]
		}
		return out
	case *[]models.StockMovement:
		if v == nil {
			return nil
		}
		out := make([]*models.StockMovement, len(*v))
		for i := range *v {
			out[i] = &(*v)[i]
		}
		return out
	default:
		return nil
	}
}
