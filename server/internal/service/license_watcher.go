package service

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog/log"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// LicenseWatcher — фоновая goroutine, которая периодически пересчитывает
// license-state для всех ресторанов и публикует EventLicenseUpdated на смене.
//
// Зачем: stateful переходы (active → grace → warning → locked) происходят
// «по часам», без events в БД. Если фронт не делает poll — он узнает о warning
// только когда сам обновит экран. Watcher решает: серверу всегда видны переходы,
// SSE-эвент уходит автоматически.
//
// Стоимость: 1 SELECT в минуту по `restaurants` (обычно одна-две строки).
type LicenseWatcher struct {
	svc      *LicenseService
	interval time.Duration

	mu    sync.Mutex
	cache map[string]State // previous state per restaurant_id
}

// NewLicenseWatcher создаёт watcher. interval=0 → 1 минута.
func NewLicenseWatcher(svc *LicenseService, interval time.Duration) *LicenseWatcher {
	if interval == 0 {
		interval = time.Minute
	}
	return &LicenseWatcher{
		svc:      svc,
		interval: interval,
		cache:    make(map[string]State),
	}
}

// Run блокирующе тикает до ctx.Done().
//
// Используется как goroutine в main:
//
//	go watcher.Run(ctx)
func (w *LicenseWatcher) Run(ctx context.Context) {
	if w.svc == nil || w.svc.pub == nil {
		log.Info().Msg("license watcher: pub or svc nil, disabled")
		return
	}
	log.Info().Dur("interval", w.interval).Msg("license watcher: started")
	t := time.NewTicker(w.interval)
	defer t.Stop()

	// Первый тик сразу (warm cache, чтобы первая итерация не выдала ложных «смен»).
	w.tick(ctx, true)
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("license watcher: stopped")
			return
		case <-t.C:
			w.tick(ctx, false)
		}
	}
}

// tick — один проход по всем ресторанам.
//
// silent=true → не публикуем events (warm-up).
func (w *LicenseWatcher) tick(ctx context.Context, silent bool) {
	var rs []models.Restaurant
	if err := w.svc.db.WithContext(ctx).
		Select("id, license_expires_at, is_blocked").
		Find(&rs).Error; err != nil {
		log.Warn().Err(err).Msg("license watcher: select restaurants failed")
		return
	}

	w.mu.Lock()
	defer w.mu.Unlock()

	for _, r := range rs {
		// Вычисляем state per-restaurant без вызова Status() (нужен tenant в ctx).
		// Дублируем небольшую логику — приемлемо, чтобы не таскать tenant-ctx.
		newState := computeState(r, time.Now().UTC())
		prev, hasPrev := w.cache[r.ID]
		w.cache[r.ID] = newState

		if silent || !hasPrev || prev == newState {
			continue
		}

		// Публикуем event. Готовим публичный Status (как делает Status()).
		statusCtx := tenant.WithRestaurant(ctx, r.ID)
		st, err := w.svc.Status(statusCtx)
		if err != nil {
			log.Warn().Err(err).Str("rid", r.ID).Msg("license watcher: status build failed")
			continue
		}
		buf := NewBuffer()
		buf.Add(EventLicenseUpdated, st)
		w.svc.pub.Flush(ctx, r.ID, buf)
		log.Info().Str("rid", r.ID).
			Str("from", string(prev)).Str("to", string(newState)).
			Msg("license state changed")
	}
}

// computeState — чистая функция: restaurant row + now → state. Дублирует
// логику Status(), но без БД-операций (для horizontal scaling без N+1).
func computeState(r models.Restaurant, now time.Time) State {
	if r.IsBlocked != nil && *r.IsBlocked {
		return StateLocked
	}
	if r.LicenseExpiresAt == nil {
		return StateNone
	}
	exp := *r.LicenseExpiresAt
	switch {
	case now.Before(exp):
		return StateActive
	case now.Before(exp.AddDate(0, 0, GraceDays)):
		return StateGrace
	case now.Before(exp.AddDate(0, 0, GraceDays+WarningDays)):
		return StateWarning
	default:
		return StateLocked
	}
}
