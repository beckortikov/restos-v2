// Package jobs — synclog_rotate.
//
// RotateSyncLog — фоновая ротация журнала синхронизации (ADR-003, Фаза О).
//
// sync_log — append-only журнал дельт для мультифилиальной сети: каждая
// мутация реплицируемой таблицы (заказ, движение склада, финопа, …) кладёт
// сюда строку с ПОЛНЫМ снимком в payload. До этой задачи журнал не чистился
// никогда — ни одного DELETE во всей кодовой базе. На кассе, работающей в
// сети годами, он растёт неограниченно, причём быстрее всех прочих таблиц
// (payload = снимок целой строки на каждое изменение).
//
// Чистим ТОЛЬКО отправленное (synced_at NOT NULL) и старше retention.
// Неотправленное не трогаем никогда, сколько бы ему ни было лет: касса могла
// простоять без интернета месяц, и это ровно те данные, которые ещё должны
// уехать на central. Карантинные строки (failed_at) тоже сохраняем — это
// материал для разбора, их удаление скрыло бы проблему.
package jobs

import (
	"context"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"
)

// SyncLogRotateConfig — параметры ротации.
type SyncLogRotateConfig struct {
	// Interval — как часто прогонять. По умолчанию 24 часа.
	Interval time.Duration
	// Retention — сколько хранить УЖЕ ОТПРАВЛЕННЫЕ строки. По умолчанию 30 дней.
	// Журнал нужен для диагностики «что и когда уехало», а не как архив:
	// авторитетные данные лежат в самих таблицах и на central.
	Retention time.Duration
}

// RunSyncLogRotateOnce — один прогон. Возвращает число удалённых строк.
func RunSyncLogRotateOnce(ctx context.Context, db *gorm.DB, retention time.Duration) (int64, error) {
	if retention <= 0 {
		retention = 30 * 24 * time.Hour
	}
	cutoff := time.Now().UTC().Add(-retention)
	// Батчами, а не одним DELETE: на кассе с многолетним журналом первый
	// прогон может задеть сотни тысяч строк, и одна длинная транзакция
	// держала бы блокировки на горячей таблице, в которую прямо сейчас
	// пишет каждая продажа.
	var total int64
	for {
		res := db.WithContext(ctx).Exec(`
			DELETE FROM sync_log
			WHERE id IN (
				SELECT id FROM sync_log
				WHERE synced_at IS NOT NULL AND synced_at < ?
				LIMIT 5000
			)`, cutoff)
		if res.Error != nil {
			return total, res.Error
		}
		total += res.RowsAffected
		if res.RowsAffected == 0 {
			return total, nil
		}
		// Уступаем место пишущим между батчами.
		select {
		case <-ctx.Done():
			return total, ctx.Err()
		case <-time.After(200 * time.Millisecond):
		}
	}
}

// SyncLogRotateScheduler гоняет ротацию по таймеру до отмены ctx.
func SyncLogRotateScheduler(ctx context.Context, db *gorm.DB, cfg SyncLogRotateConfig) {
	if cfg.Interval <= 0 {
		cfg.Interval = 24 * time.Hour
	}
	if cfg.Retention <= 0 {
		cfg.Retention = 30 * 24 * time.Hour
	}
	log.Info().Dur("interval", cfg.Interval).Dur("retention", cfg.Retention).
		Msg("sync_log rotate scheduler: started")

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("sync_log rotate scheduler: stopped")
			return
		case <-ticker.C:
			n, err := RunSyncLogRotateOnce(ctx, db, cfg.Retention)
			if err != nil {
				log.Error().Err(err).Msg("sync_log rotate: failed")
				continue
			}
			if n > 0 {
				log.Info().Int64("deleted", n).Msg("sync_log rotate: старые отправленные дельты удалены")
			}
		}
	}
}
