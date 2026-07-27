package db

import (
	"context"
	"fmt"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"
)

// schemaSelfHealStmts — идемпотентный DDL, дублирующий СХЕМНУЮ часть
// drift-опасных миграций. Выполняется на КАЖДОМ старте после goose,
// НЕЗАВИСИМО от goose_db_version.
//
// Зачем: на кассах (embedded-postgres на Windows) фиксировали рассинхрон —
// goose_db_version говорит «миграция применена», а реального DDL в схеме нет.
// Механизм: зомби-Postgres на порту 54330 переживает авто-апдейт, новый бэк
// цепляется к старому/другому кластеру; плюс когда-то падала миграция 035
// (uncast uuid=text) и старый авто-wipe добивал состояние. Симптом
// (инцидент 15.07.2026): при добавлении покупного товара —
//
//	столбец "warehouse_id" в таблице "ingredients" не существует (SQLSTATE 42703)
//
// хотя goose_db_version = 36. Одноразовой миграцией это НЕ лечится — goose
// считает её уже применённой и не запустит повторно. Поэтому критичную схему
// до-гарантируем принудительно на каждом boot.
//
// ВСЕ выражения ОБЯЗАНЫ быть идемпотентными (IF NOT EXISTS) — на здоровой БД
// это no-op. Зеркалит схемную часть 036_multi_warehouse.
var schemaSelfHealStmts = []string{
	`CREATE TABLE IF NOT EXISTS warehouses (
		id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		name          TEXT NOT NULL,
		kind          TEXT NOT NULL CHECK (kind IN ('products','purchased','supplies')),
		restaurant_id TEXT,
		created_at    TIMESTAMPTZ DEFAULT now(),
		updated_at    TIMESTAMPTZ DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_warehouses_restaurant ON warehouses (restaurant_id)`,
	`CREATE UNIQUE INDEX IF NOT EXISTS uq_warehouses_rest_kind ON warehouses (restaurant_id, kind)`,
	`ALTER TABLE ingredients ADD COLUMN IF NOT EXISTS warehouse_id UUID`,
	`CREATE INDEX IF NOT EXISTS idx_ingredients_warehouse ON ingredients (warehouse_id)`,
	`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS warehouse_id      UUID`,
	`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS from_warehouse_id UUID`,
	`ALTER TABLE stock_movements ADD COLUMN IF NOT EXISTS to_warehouse_id   UUID`,
	// 063: отключение счетов. Без is_enabled любой SELECT по счетам падает
	// с "column does not exist" — а счета читает каждая оплата заказа.
	`ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS is_enabled  BOOLEAN NOT NULL DEFAULT true`,
	`ALTER TABLE financial_accounts ADD COLUMN IF NOT EXISTS disabled_at TIMESTAMPTZ`,
}

// backfillSelfHealStmts — best-effort раскладка: 3 фиксированных склада на
// ресторан + присвоение складам ещё НЕ размеченных (warehouse_id IS NULL)
// ингредиентов. При ошибке старт НЕ валим (схема уже гарантирована выше).
//
// Важно: во всех UPDATE стоит `i.warehouse_id IS NULL` — повторный boot не
// перетаскивает уже размещённые товары (в т.ч. вручную перемещённые кассиром)
// обратно. В самой миграции 036 у ветки purchased этого guard'а не было (там
// первый прогон), для повторяемого self-heal он обязателен.
var backfillSelfHealStmts = []string{
	`INSERT INTO warehouses (name, kind, restaurant_id)
	 SELECT DISTINCT 'Продукты', 'products', restaurant_id
	 FROM ingredients WHERE restaurant_id IS NOT NULL
	 ON CONFLICT (restaurant_id, kind) DO NOTHING`,
	`INSERT INTO warehouses (name, kind, restaurant_id)
	 SELECT DISTINCT 'Покупные товары', 'purchased', restaurant_id
	 FROM ingredients WHERE restaurant_id IS NOT NULL
	 ON CONFLICT (restaurant_id, kind) DO NOTHING`,
	`INSERT INTO warehouses (name, kind, restaurant_id)
	 SELECT DISTINCT 'Хозтовары', 'supplies', restaurant_id
	 FROM ingredients WHERE restaurant_id IS NOT NULL
	 ON CONFLICT (restaurant_id, kind) DO NOTHING`,
	// Покупные: ingredient входит в техкарту блюда-товара (is_purchased).
	`UPDATE ingredients i SET warehouse_id = w.id
	 FROM warehouses w
	 WHERE w.restaurant_id = i.restaurant_id AND w.kind = 'purchased'
	   AND i.warehouse_id IS NULL
	   AND i.id IN (
	     SELECT tcl.ingredient_id FROM tech_card_lines tcl
	     JOIN menu_items mi ON mi.id = tcl.menu_item_id
	     WHERE mi.is_purchased = TRUE AND tcl.ingredient_id IS NOT NULL
	   )`,
	// Хозтовары: не еда.
	`UPDATE ingredients i SET warehouse_id = w.id
	 FROM warehouses w
	 WHERE w.restaurant_id = i.restaurant_id AND w.kind = 'supplies'
	   AND i.warehouse_id IS NULL AND i.is_food = FALSE`,
	// Продукты: всё остальное.
	`UPDATE ingredients i SET warehouse_id = w.id
	 FROM warehouses w
	 WHERE w.restaurant_id = i.restaurant_id AND w.kind = 'products'
	   AND i.warehouse_id IS NULL`,
}

// EnsureCriticalSchema принудительно до-гарантирует критичную (drift-опасную)
// схему мультисклада. Идемпотентно; на здоровой БД — no-op. Вызывается ПОСЛЕ
// goose на каждом старте. Схемные statements критичны (при ошибке валим старт),
// раскладка — best-effort (ошибка → warn, старт продолжается).
func EnsureCriticalSchema(ctx context.Context, gdb *gorm.DB) error {
	// Детект дрейфа — только ради информативного лога на кассе.
	var hasWarehouseCol bool
	if err := gdb.WithContext(ctx).Raw(
		`SELECT EXISTS (SELECT 1 FROM information_schema.columns
		 WHERE table_name = 'ingredients' AND column_name = 'warehouse_id')`,
	).Scan(&hasWarehouseCol).Error; err != nil {
		return fmt.Errorf("self-heal detect: %w", err)
	}
	if !hasWarehouseCol {
		log.Warn().Msg("self-heal схемы: обнаружен рассинхрон (нет ingredients.warehouse_id) — восстанавливаю схему мультисклада")
	}

	for _, stmt := range schemaSelfHealStmts {
		if err := gdb.WithContext(ctx).Exec(stmt).Error; err != nil {
			return fmt.Errorf("self-heal schema: %w", err)
		}
	}
	for _, stmt := range backfillSelfHealStmts {
		if err := gdb.WithContext(ctx).Exec(stmt).Error; err != nil {
			log.Warn().Err(err).Msg("self-heal backfill: шаг пропущен (не критично)")
		}
	}

	if !hasWarehouseCol {
		log.Info().Msg("self-heal схемы: схема мультисклада восстановлена")
	}
	return nil
}
