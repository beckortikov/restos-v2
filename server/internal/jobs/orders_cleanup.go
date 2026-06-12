// Package jobs — orders_cleanup.
//
// CleanupZombieOrders — фоновая задача (v2.1.2). Каждые 5 минут переводит
// orders, у которых status ∈ {new,open,cooking,ready,served,bill_requested}
// и 0 живых items, в status='cancelled' и освобождает связанные столы.
//
// Зачем: invariant «void последнего item → auto-cancel order + free table»
// уже реализован в orders_void.go (v2.1.1). Но если по какой-то причине
// он не сработал (прямой SQL, race, баг будущей фичи) — этот watchdog
// подберёт зомби и приведёт состояние в норму. Дёшево, идемпотентно.
package jobs

import (
	"context"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"
)

// OrdersCleanupConfig — параметры cleanup-job.
type OrdersCleanupConfig struct {
	// Interval — как часто прогонять. По умолчанию 5 минут.
	Interval time.Duration
}

// orderRow — внутренняя строка, которую возвращает SELECT в RunOrdersCleanupOnce.
type orderRow struct {
	ID           string
	TableID      *string
	RestaurantID *string
}

// RunOrdersCleanupOnce — один прогон. Возвращает (cancelledOrders, freedTables, err).
//
// Логика 1:1 совпадает с migration 016_cleanup_zombie_orders.sql, чтобы
// поведение «фоновый прогон vs миграция» было неотличимо.
func RunOrdersCleanupOnce(ctx context.Context, db *gorm.DB) (int, int, error) {
	var cancelledOrders, freedTables int

	err := db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 0. Table-anchored reconciliation (v3.9.3). Освобождаем столы которые
		// помечены 'occupied', но НА НИХ НЕТ активных заказов. Это ловит
		// зомби-столы которые зомби-order pass ниже не видит: все заказы уже
		// closed/cancelled/refunded, но free-on-close по какой-то причине не
		// сработал (race, частичная tx, ручной SQL, refund-путь).
		tableSweep := tx.Exec(`
			UPDATE tables t
			SET status = 'free', current_order_id = NULL, opened_at = NULL, updated_at = NOW()
			WHERE t.status = 'occupied'
			  AND NOT EXISTS (
				SELECT 1 FROM orders o
				WHERE o.table_id = t.id::text
				  AND o.restaurant_id IS NOT DISTINCT FROM t.restaurant_id
				  AND o.status IN ('new','open','cooking','ready','served','bill_requested')
			  )
		`)
		if tableSweep.Error != nil {
			return tableSweep.Error
		}
		freedTables += int(tableSweep.RowsAffected)

		// 1. Найти zombies (active order с 0 живыми позициями).
		var rows []orderRow
		if err := tx.Raw(`
			SELECT o.id, o.table_id, o.restaurant_id
			FROM orders o
			WHERE o.status IN ('new','open','cooking','ready','served','bill_requested')
			  AND NOT EXISTS (
				SELECT 1 FROM order_items oi
				WHERE oi.order_id = o.id AND oi.cancelled_at IS NULL
			  )
		`).Scan(&rows).Error; err != nil {
			return err
		}
		if len(rows) == 0 {
			return nil
		}

		ids := make([]string, 0, len(rows))
		for _, r := range rows {
			ids = append(ids, r.ID)
		}

		// 2. Перевести их в cancelled.
		res := tx.Exec(`
			UPDATE orders
			SET status          = 'cancelled',
			    cancelled_at    = NOW(),
			    cancel_reason   = 'Auto-cleanup (все позиции отменены)',
			    cancelled_total = 0,
			    updated_at      = NOW()
			WHERE id IN (?)
		`, ids)
		if res.Error != nil {
			return res.Error
		}
		cancelledOrders = int(res.RowsAffected)

		// 3. Собрать (table_id, restaurant_id) candidates и освободить те,
		// где не осталось других активных заказов.
		seen := map[string]bool{}
		for _, r := range rows {
			if r.TableID == nil || *r.TableID == "" {
				continue
			}
			key := *r.TableID
			if seen[key] {
				continue
			}
			seen[key] = true

			var activeCount int64
			q := tx.Table("orders").
				Where("table_id = ?", *r.TableID).
				Where("status IN ?", []string{"new", "open", "cooking", "ready", "served", "bill_requested"})
			if r.RestaurantID != nil {
				q = q.Where("restaurant_id = ?", *r.RestaurantID)
			}
			if err := q.Count(&activeCount).Error; err != nil {
				return err
			}
			if activeCount > 0 {
				continue
			}

			tq := tx.Table("tables").Where("id = ?", *r.TableID)
			if r.RestaurantID != nil {
				tq = tq.Where("restaurant_id = ?", *r.RestaurantID)
			}
			tres := tq.Updates(map[string]any{
				"status":           "free",
				"current_order_id": nil,
				"opened_at":        nil,
				"updated_at":       time.Now(),
			})
			if tres.Error != nil {
				return tres.Error
			}
			freedTables += int(tres.RowsAffected)
		}

		return nil
	})

	return cancelledOrders, freedTables, err
}

// OrdersCleanupScheduler — фоновый цикл. Останавливается по ctx.Done().
func OrdersCleanupScheduler(ctx context.Context, db *gorm.DB, cfg OrdersCleanupConfig) {
	if cfg.Interval <= 0 {
		cfg.Interval = 5 * time.Minute
	}
	log.Info().Dur("interval", cfg.Interval).Msg("orders cleanup scheduler: started")

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("orders cleanup scheduler: stopped")
			return
		case <-ticker.C:
			cancelled, freed, err := RunOrdersCleanupOnce(ctx, db)
			if err != nil {
				log.Error().Err(err).Msg("orders cleanup: run failed")
				continue
			}
			if cancelled > 0 || freed > 0 {
				log.Warn().
					Int("cancelled_orders", cancelled).
					Int("freed_tables", freed).
					Msg("orders cleanup: zombies fixed")
			}
		}
	}
}
