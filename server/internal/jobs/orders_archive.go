// Package jobs — orders_archive.
//
// ArchiveClosedOrders переносит закрытые orders старше threshold в
// orders_archive. Вызывается **при закрытии смены** (fire-and-forget)
// в горутине, чтобы не задерживать UI.
//
// Зачем: см. migration 021 — таблица orders не должна разрастаться
// в десятки тысяч закрытых строк. Архив отдельно, активные запросы
// быстрые.
//
// Принципы:
//   - Идемпотентность: повторный запуск ничего не ломает, INSERT/DELETE
//     в транзакции, ON CONFLICT DO NOTHING на случай дубликата.
//   - Batch: по 500 строк за итерацию, чтобы не блокировать таблицу.
//   - Threshold по дефолту 365 дней. Конфигурируется через RESTOS_ARCHIVE_DAYS.
//   - Никаких FK-каскадов: order_items / order_voids / order_splits
//     ОСТАЮТСЯ привязаны к orders_archive.id (FK не настроен — это OK,
//     история live в child-таблицах + ссылка на archive parent).
//
// Безопасность: если архивный INSERT упал — соответствующий DELETE
// не выполнится (одна транзакция), order останется в orders. Логируем
// и продолжаем со следующим batch'ем.
package jobs

import (
	"context"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"
)

// ArchiveConfig — параметры архивации.
type ArchiveConfig struct {
	// ThresholdDays — заказы закрытые более N дней назад идут в архив.
	// 365 покрывает год → owner всегда видит «прошлый сезон» без архива.
	ThresholdDays int
	// BatchSize — сколько строк за итерацию (UPDATE/INSERT/DELETE).
	BatchSize int
	// MaxBatches — потолок батчей за один запуск. Защита от вечного цикла.
	MaxBatches int
}

func DefaultArchiveConfig() ArchiveConfig {
	return ArchiveConfig{
		ThresholdDays: 365,
		BatchSize:     500,
		MaxBatches:    20, // максимум 10000 заказов за один прогон
	}
}

// RunArchiveOnce — один прогон. Возвращает (archived, err).
//
// Алгоритм:
//   1. SELECT id FROM orders WHERE status IN ('closed','cancelled') AND closed_at < cutoff LIMIT N
//   2. В одной транзакции:
//      INSERT INTO orders_archive SELECT * FROM orders WHERE id IN (...) ON CONFLICT DO NOTHING
//      DELETE FROM orders WHERE id IN (...)
//   3. Если за итерацию ничего не выбрали — выходим.
func RunArchiveOnce(ctx context.Context, db *gorm.DB, cfg ArchiveConfig) (int, error) {
	if cfg.BatchSize <= 0 {
		cfg.BatchSize = 500
	}
	if cfg.MaxBatches <= 0 {
		cfg.MaxBatches = 20
	}
	if cfg.ThresholdDays <= 0 {
		cfg.ThresholdDays = 365
	}
	cutoff := time.Now().UTC().AddDate(0, 0, -cfg.ThresholdDays)

	total := 0
	for batch := 0; batch < cfg.MaxBatches; batch++ {
		if ctx.Err() != nil {
			return total, ctx.Err()
		}
		// Выбираем id'ы кандидатов под архивирование.
		var ids []string
		err := db.WithContext(ctx).
			Raw(`SELECT id FROM orders
			     WHERE status IN ('closed','cancelled')
			       AND closed_at IS NOT NULL
			       AND closed_at < ?
			     ORDER BY closed_at ASC
			     LIMIT ?`, cutoff, cfg.BatchSize).
			Scan(&ids).Error
		if err != nil {
			return total, err
		}
		if len(ids) == 0 {
			break
		}

		// Перенос в транзакции. ON CONFLICT DO NOTHING — на случай если
		// предыдущий прогон упал ПОСЛЕ INSERT но ДО DELETE (никогда не
		// должно случиться в одной tx, но cheap insurance).
		err = db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
			if err := tx.Exec(`
				INSERT INTO orders_archive
				SELECT * FROM orders WHERE id IN ?
				ON CONFLICT (id) DO NOTHING
			`, ids).Error; err != nil {
				return err
			}
			if err := tx.Exec(`DELETE FROM orders WHERE id IN ?`, ids).Error; err != nil {
				return err
			}
			return nil
		})
		if err != nil {
			log.Error().Err(err).Int("batch", batch).Int("ids", len(ids)).
				Msg("archive batch failed")
			return total, err
		}
		total += len(ids)
		log.Debug().Int("batch", batch).Int("archived", len(ids)).Int("total", total).
			Msg("archive batch done")
	}

	if total > 0 {
		log.Info().Int("archived", total).Time("cutoff", cutoff).
			Msg("orders archive: batch completed")
	}
	return total, nil
}

// RunArchiveAsync — fire-and-forget обёртка. Вызывается из shift close.
// Запускает в горутине, чтобы не блокировать ответ кассиру.
func RunArchiveAsync(db *gorm.DB, cfg ArchiveConfig) {
	go func() {
		// Свой контекст с таймаутом — архивация не должна висеть вечно.
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Minute)
		defer cancel()
		archived, err := RunArchiveOnce(ctx, db, cfg)
		if err != nil {
			log.Warn().Err(err).Int("archived", archived).
				Msg("orders archive: async run errored")
			return
		}
		if archived > 0 {
			log.Info().Int("archived", archived).
				Msg("orders archive: async run completed (triggered by shift close)")
		}
	}()
}
