// Package jobs — attendance_photos.
//
// Ретенция селфи при отметках (103). Оригиналы снимков лежат файлами в
// <data-dir>/attendance/ГГГГ-ММ/ и копятся по два на сотрудника в день: 20
// человек × 2 × 30 дней ≈ 1200 файлов и ~50 МБ в месяц. Держать их вечно
// незачем — спор «это не я отмечался» живёт максимум до расчёта зарплаты за
// период, а дальше это просто накопленные фотографии людей.
//
// Чистим ТОЛЬКО файлы; строки в БД остаются с обнулённым path. Превью (8 КБ)
// переживает ретенцию сознательно: по нему в перекличке за прошлый год видно,
// что снимок был и кто на нём, а место это почти не занимает.
package jobs

import (
	"context"
	"time"

	"github.com/rs/zerolog/log"
)

// AttendancePhotoPurger — то, что умеет чистить (реализует
// service.AttendancePhotoStore).
type AttendancePhotoPurger interface {
	Enabled() bool
	Purge(ctx context.Context, retention time.Duration) (int, error)
}

// AttendancePhotoPurgeConfig — параметры чистки.
type AttendancePhotoPurgeConfig struct {
	// Interval — как часто прогонять. По умолчанию 24 часа.
	Interval time.Duration
	// Retention — сколько хранить оригиналы. По умолчанию 90 дней.
	Retention time.Duration
}

// AttendancePhotoPurgeScheduler гоняет чистку по таймеру до отмены ctx.
func AttendancePhotoPurgeScheduler(ctx context.Context, store AttendancePhotoPurger, cfg AttendancePhotoPurgeConfig) {
	if store == nil || !store.Enabled() {
		return
	}
	if cfg.Interval <= 0 {
		cfg.Interval = 24 * time.Hour
	}
	if cfg.Retention <= 0 {
		cfg.Retention = 90 * 24 * time.Hour
	}
	log.Info().Dur("interval", cfg.Interval).Dur("retention", cfg.Retention).
		Msg("attendance photo purge: started")

	ticker := time.NewTicker(cfg.Interval)
	defer ticker.Stop()

	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("attendance photo purge: stopped")
			return
		case <-ticker.C:
			removed, err := store.Purge(ctx, cfg.Retention)
			if err != nil {
				// Не фатально: снимки — вспомогательные данные, и падать из-за
				// них касса не должна.
				log.Warn().Err(err).Msg("attendance photo purge: ошибка")
				continue
			}
			if removed > 0 {
				log.Info().Int("removed", removed).Msg("attendance photo purge: удалены старые снимки")
			}
		}
	}
}
