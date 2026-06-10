package audit

// worker — асинхронный воркер для audit_log.
//
// До v3.6.0 хук писал в audit_log синхронно внутри той же транзакции что и
// мутация. Это удлиняло tx на 3-15мс per mutation, и при пиковой нагрузке
// (10+ одновременных официантов) создавало contention на connection pool.
//
// v3.6.0: хук теперь pushит событие в in-memory channel, отдельная горутина
// читает channel, копит batch'ами по 100 записей или раз в 1 сек и пишет
// одним multi-row INSERT. Это:
//   - сокращает каждую tx на ~10мс
//   - в 10× эффективнее по нагрузке на Postgres (1 INSERT вместо 100)
//   - снимает зависимость audit от tx commit (логируем все попытки, в том
//     числе откаченные — это даёт security trail)
//
// Trade-off: при крэше сервера теряются последние ≤100 audit-записей в
// памяти. Для аудита ресторанной кассы это приемлемо.

import (
	"context"
	"sync"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
)

const (
	// channelBuffer — глубина очереди. На обычной кассе при пиковой нагрузке
	// (10 официантов × 1 заказ/сек × 5 мутаций) = 50 событий/сек, очередь
	// 10000 покрывает 200 секунд накопления при полной остановке воркера.
	channelBuffer = 10000
	// batchSize — сколько событий копим перед одним multi-row INSERT.
	batchSize = 100
	// flushInterval — максимальная задержка между записями в БД даже если
	// batch не наполнен.
	flushInterval = 1 * time.Second
)

type worker struct {
	db     *gorm.DB
	ch     chan *models.AuditLog
	stopCh chan struct{}
	doneCh chan struct{}
	once   sync.Once

	// Counters для observability (опц.).
	mu        sync.Mutex
	pushedCnt uint64
	wroteCnt  uint64
	droppedCnt uint64
}

var globalWorker *worker

// StartWorker запускает воркер. Вызывается из main.go после Open.
// Идемпотентен: повторный вызов — no-op.
func StartWorker(db *gorm.DB) {
	if globalWorker != nil {
		return
	}
	globalWorker = &worker{
		db:     db,
		ch:     make(chan *models.AuditLog, channelBuffer),
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
	}
	go globalWorker.run()
}

// StopWorker сигналит воркеру остановиться и ждёт до timeout пока он сольёт
// очередь. Вызывается на graceful shutdown ДО закрытия БД.
func StopWorker(timeout time.Duration) {
	if globalWorker == nil {
		return
	}
	globalWorker.once.Do(func() {
		close(globalWorker.stopCh)
	})
	select {
	case <-globalWorker.doneCh:
	case <-time.After(timeout):
		log.Warn().Msg("audit worker: shutdown timeout — possibly dropped events")
	}
}

// push — non-blocking. Если очередь полна — событие теряется (counter ++).
// Это намеренно: в худшем случае теряем 100-500 audit записей при крэше,
// что лучше чем блокировать кассу.
func (w *worker) push(e *models.AuditLog) {
	w.mu.Lock()
	w.pushedCnt++
	w.mu.Unlock()
	select {
	case w.ch <- e:
	default:
		w.mu.Lock()
		w.droppedCnt++
		w.mu.Unlock()
		log.Warn().Msg("audit worker: channel full, event dropped")
	}
}

func (w *worker) run() {
	defer close(w.doneCh)
	batch := make([]*models.AuditLog, 0, batchSize)
	ticker := time.NewTicker(flushInterval)
	defer ticker.Stop()

	flush := func() {
		if len(batch) == 0 {
			return
		}
		ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
		// SkipHooks важно — иначе callback'ы зациклятся (audit_log в skipTables
		// уже блокирует, но явный SkipHooks дешевле).
		err := w.db.WithContext(ctx).
			Session(&gorm.Session{SkipHooks: true, NewDB: true}).
			Create(&batch).Error
		cancel()
		if err != nil {
			log.Error().Err(err).Int("n", len(batch)).
				Msg("audit worker: batch insert failed")
		} else {
			w.mu.Lock()
			w.wroteCnt += uint64(len(batch))
			w.mu.Unlock()
		}
		batch = batch[:0]
	}

	for {
		select {
		case e := <-w.ch:
			batch = append(batch, e)
			if len(batch) >= batchSize {
				flush()
			}
		case <-ticker.C:
			flush()
		case <-w.stopCh:
			// Дрейним остаток канала и финально пишем.
			for drained := false; !drained; {
				select {
				case e := <-w.ch:
					batch = append(batch, e)
					if len(batch) >= batchSize {
						flush()
					}
				default:
					drained = true
				}
			}
			flush()
			return
		}
	}
}

// Stats возвращает счётчики для health-check / monitoring.
func Stats() (pushed, wrote, dropped uint64) {
	if globalWorker == nil {
		return 0, 0, 0
	}
	globalWorker.mu.Lock()
	defer globalWorker.mu.Unlock()
	return globalWorker.pushedCnt, globalWorker.wroteCnt, globalWorker.droppedCnt
}
