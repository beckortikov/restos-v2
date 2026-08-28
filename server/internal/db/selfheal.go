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
	// 064: честный выбор режима выплаты ЗП/аванса/обслуживания + удержания
	// с сохранённой причиной. financial_operations читается на каждом
	// экране финансов — без is_enabled колонки SELECT падает целиком.
	`ALTER TABLE financial_operations ADD COLUMN IF NOT EXISTS is_override BOOLEAN NOT NULL DEFAULT false`,
	// 071: отмена выплаты зарплаты. CancelSalary читает/пишет cancelled_at на
	// каждой отмене, а SalaryReport SELECT'ит колонку на каждом открытии —
	// без неё отчёт зарплаты и отмена падают.
	`ALTER TABLE financial_operations ADD COLUMN IF NOT EXISTS cancelled_at TIMESTAMPTZ`,
	`ALTER TABLE financial_operations ADD COLUMN IF NOT EXISTS cancelled_by TEXT`,
	// 082: период начисления (YYYY-MM) зарплатной/авансовой проводки. Кап на
	// выплату (salaryCapForPeriod) и начисления (SalaryAccrual) читают её на
	// каждой открытии «Зарплаты» и на каждой попытке выплатить — без колонки
	// оба падают целиком, а не просто теряют функциональность.
	`ALTER TABLE financial_operations ADD COLUMN IF NOT EXISTS salary_period TEXT`,
	// 083: остаток текущего цикла регулярного платежа при частичной оплате.
	// RecurringPaymentsService.Pay читает/пишет обе колонки на КАЖДОЙ оплате
	// (аренда/погашение долга и т.п.) — без них платёж падает целиком.
	`ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS remaining_amount NUMERIC(14,4)`,
	`ALTER TABLE recurring_payments ADD COLUMN IF NOT EXISTS last_paid_amount NUMERIC(14,4)`,
	// 072: настройки ТВ-табло выдачи. restaurants читается на каждом старте
	// (auth-контекст, настройки, табло) — при дрейфе SELECT по модели с новыми
	// полями иначе не досчитается колонок; гарантируем до-наличие.
	`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS board_stations     TEXT`,
	`ALTER TABLE restaurants ADD COLUMN IF NOT EXISTS board_logo_opacity INTEGER`,
	// 073: сеты (bundle) — фастфуд-комбо из настоящих пунктов меню. Читается на
	// каждом открытии меню (is_bundle) и на каждом добавлении сета в заказ
	// (bundle_slots/bundle_slot_options) — без до-гарантии SELECT падает.
	`ALTER TABLE menu_items ADD COLUMN IF NOT EXISTS is_bundle BOOLEAN NOT NULL DEFAULT false`,
	`CREATE TABLE IF NOT EXISTS bundle_slots (
		id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		restaurant_id       TEXT,
		bundle_menu_item_id UUID NOT NULL,
		label               TEXT NOT NULL,
		is_required         BOOLEAN NOT NULL DEFAULT true,
		min_select          INT NOT NULL DEFAULT 1,
		max_select          INT NOT NULL DEFAULT 1,
		sort_order          INT NOT NULL DEFAULT 0,
		created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_bundle_slots_restaurant ON bundle_slots (restaurant_id)`,
	`CREATE INDEX IF NOT EXISTS idx_bundle_slots_bundle_item ON bundle_slots (bundle_menu_item_id)`,
	`CREATE TABLE IF NOT EXISTS bundle_slot_options (
		id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		slot_id             UUID NOT NULL,
		option_menu_item_id UUID NOT NULL,
		price               NUMERIC(14,4) NOT NULL DEFAULT 0,
		is_default          BOOLEAN NOT NULL DEFAULT false,
		sort_order          INT NOT NULL DEFAULT 0,
		created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
		updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_bundle_slot_options_slot ON bundle_slot_options (slot_id)`,
	`CREATE INDEX IF NOT EXISTS idx_bundle_slot_options_item ON bundle_slot_options (option_menu_item_id)`,
	`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bundle_group_id UUID`,
	`ALTER TABLE order_items ADD COLUMN IF NOT EXISTS bundle_slot_label TEXT`,
	`CREATE INDEX IF NOT EXISTS idx_order_items_bundle_group ON order_items (bundle_group_id)`,
	`CREATE TABLE IF NOT EXISTS salary_deductions (
		id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		restaurant_id TEXT,
		user_id       UUID NOT NULL,
		amount        NUMERIC(14,4) NOT NULL CHECK (amount > 0),
		reason        TEXT NOT NULL,
		created_by    TEXT,
		created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
	)`,
	`CREATE INDEX IF NOT EXISTS idx_salary_deductions_user ON salary_deductions (user_id, created_at DESC)`,
	// 066: «две смены в один день» — множитель дневной оплаты. Найден вживую
	// (Ф5б, 04.08.2026) собственный экземпляр drift-класса из шапки файла:
	// эта ветка и main независимо заняли номер 066 разным содержимым
	// (salary_day_multiplier vs sync_backfilled_at); после переномерации
	// своей миграции в 072 уже смигрированные БД, где старый 066 успел
	// применить ЧУЖОЕ содержимое, никогда не увидят настоящую
	// 066_salary_day_multiplier — goose считает версию 66 закрытой. Симптом:
	// `relation "salary_day_multipliers" does not exist` при goose_db_version=72.
	`CREATE TABLE IF NOT EXISTS salary_day_multipliers (
		id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
		restaurant_id TEXT NOT NULL,
		user_id       UUID NOT NULL,
		work_date     DATE NOT NULL,
		multiplier    INTEGER NOT NULL DEFAULT 2,
		created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
		UNIQUE (restaurant_id, user_id, work_date)
	)`,
	`DO $$
	BEGIN
		IF NOT EXISTS (
			SELECT 1 FROM pg_constraint WHERE conname = 'salary_day_multipliers_multiplier_chk'
		) THEN
			ALTER TABLE salary_day_multipliers
				ADD CONSTRAINT salary_day_multipliers_multiplier_chk
				CHECK (multiplier >= 2 AND multiplier <= 3);
		END IF;
	END $$`,
	`CREATE INDEX IF NOT EXISTS idx_salary_day_multipliers_lookup
		ON salary_day_multipliers (restaurant_id, user_id, work_date)`,
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
	// Вариант (Размер/Вкус) наследует category/station/unit от родителя ТОЛЬКО
	// при генерации (menu_variants.go createVariant, один раз при создании) —
	// код, правящий эти поля на родителе (PatchItem, applyNetworkMenu), их не
	// каскадил, вариант навсегда застревал на цехе на момент создания. Найдено
	// вживую: central сменил «Шаурма»/«Гиро» на Холодный цех, кухонные тикеты
	// на размерные варианты продолжали печататься на горячем цехе — код-фикс
	// (menu_write.go PatchItem + sync_ingest.go applyNetworkMenu) остановил
	// НОВЫЙ дрейф, но не чинит уже накопленный. IS DISTINCT FROM — сам себе
	// guard: повторный boot ничего не находит и не трогает.
	`UPDATE menu_items v SET station = p.station, category = p.category, unit = p.unit, updated_at = now()
	 FROM menu_items p
	 WHERE v.parent_id = p.id AND v.is_deleted = false AND p.is_deleted = false
	   AND (v.station IS DISTINCT FROM p.station
	        OR v.category IS DISTINCT FROM p.category
	        OR v.unit IS DISTINCT FROM p.unit)`,
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
	var hasDayMultipliersTable bool
	if err := gdb.WithContext(ctx).Raw(
		`SELECT EXISTS (SELECT 1 FROM information_schema.tables WHERE table_name = 'salary_day_multipliers')`,
	).Scan(&hasDayMultipliersTable).Error; err != nil {
		return fmt.Errorf("self-heal detect: %w", err)
	}
	if !hasDayMultipliersTable {
		log.Warn().Msg("self-heal схемы: обнаружен рассинхрон (нет salary_day_multipliers) — восстанавливаю таблицу")
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
	if !hasDayMultipliersTable {
		log.Info().Msg("self-heal схемы: salary_day_multipliers восстановлена")
	}
	return nil
}
