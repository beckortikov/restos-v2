package printer

import (
	"context"
	"errors"
	"math"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// Queue — воркер очереди print_jobs.
//
// Архитектура:
//   - Воркер тикает каждые pollInterval секунд (default 1s).
//   - SELECT … WHERE status='pending' LIMIT N FOR UPDATE SKIP LOCKED.
//   - Для каждого job: маршрутизация по printer_id (или fallback к default
//     printer), Send, на успех status=done printed_at=now; на ошибку attempts++
//     с exponential backoff (last_error).
//   - После maxAttempts → status=failed (требует ручного вмешательства Manager-а).
//
// "FOR UPDATE SKIP LOCKED" даёт корректную работу при многих воркерах
// (один на машину, но мало ли).
type Queue struct {
	db     *gorm.DB
	router Router
	cfg    QueueConfig
}

// Router — стратегия выбора Printer по job. В простейшем случае — мапа
// printer_id → Printer. В сложном — учёт типа документа (receipt vs runner)
// и station.
type Router interface {
	// Resolve возвращает Printer для job. nil если не нашёл.
	Resolve(job *models.PrintJob) Printer
}

// QueueConfig — параметры воркера.
type QueueConfig struct {
	PollInterval time.Duration // default 1s
	BatchSize    int           // default 10 jobs за тик
	MaxAttempts  int           // default 5
	BaseBackoff  time.Duration // default 2s (×2^attempts)
}

func (c *QueueConfig) defaults() {
	if c.PollInterval == 0 {
		c.PollInterval = time.Second
	}
	if c.BatchSize == 0 {
		c.BatchSize = 10
	}
	if c.MaxAttempts == 0 {
		c.MaxAttempts = 5
	}
	if c.BaseBackoff == 0 {
		c.BaseBackoff = 2 * time.Second
	}
}

// NewQueue создаёт воркер. Запускается через Run(ctx).
func NewQueue(db *gorm.DB, router Router, cfg QueueConfig) *Queue {
	cfg.defaults()
	return &Queue{db: db, router: router, cfg: cfg}
}

// Run — блокирующий цикл. Останавливается по ctx.Done().
//
// Используется как goroutine в main:
//
//	go queue.Run(ctx)
func (q *Queue) Run(ctx context.Context) {
	log.Info().Dur("poll", q.cfg.PollInterval).Msg("print queue: started")
	t := time.NewTicker(q.cfg.PollInterval)
	defer t.Stop()
	for {
		select {
		case <-ctx.Done():
			log.Info().Msg("print queue: stopped")
			return
		case <-t.C:
			if err := q.tick(ctx); err != nil {
				log.Warn().Err(err).Msg("print queue: tick error")
			}
		}
	}
}

func (q *Queue) tick(ctx context.Context) error {
	jobs, err := q.claim(ctx)
	if err != nil {
		return err
	}
	for _, j := range jobs {
		q.process(ctx, j)
	}
	return nil
}

// claim берёт N pending job'ов в одной транзакции и помечает status='running'.
// Это эквивалент "FOR UPDATE SKIP LOCKED" — другие воркеры эти строки не возьмут.
func (q *Queue) claim(ctx context.Context) ([]*models.PrintJob, error) {
	now := time.Now().UTC()
	var jobs []*models.PrintJob

	err := q.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		// 1. SELECT pending jobs, готовые к выполнению (next_retry_at в прошлом).
		// В нашей схеме print_jobs нет next_retry_at; берём pending'и которые
		// updated_at + backoff(attempts) < now. backoff = base * 2^attempts.
		// Реализуем через WHERE: created_at <= now-base ИЛИ status='pending' AND attempts=0.
		// Упрощённо: берём все pending; если backoff не подошёл — skip в процессе.
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE", Options: "SKIP LOCKED"}).
			Where("status = ?", "pending").
			Order("created_at ASC").
			Limit(q.cfg.BatchSize).
			Find(&jobs).Error; err != nil {
			return err
		}

		// Фильтруем по backoff и помечаем claimed (status='running').
		ready := jobs[:0]
		for _, j := range jobs {
			delay := q.backoff(j.Attempts)
			if !j.UpdatedAt.Add(delay).Before(now) {
				continue // ещё рано retry'ить
			}
			j.Status = "running"
			j.UpdatedAt = now
			if err := tx.Save(j).Error; err != nil {
				return err
			}
			ready = append(ready, j)
		}
		jobs = ready
		return nil
	})
	if err != nil {
		return nil, err
	}
	return jobs, nil
}

// process отправляет один job в принтер. Обновляет status/attempts/last_error.
func (q *Queue) process(ctx context.Context, j *models.PrintJob) {
	now := time.Now().UTC()

	pr := q.router.Resolve(j)
	if pr == nil {
		q.fail(j, "no printer for job", now, true)
		return
	}

	// Отправляем с разумным timeout — TCP-driver сам уважает свой DialTimeout,
	// но добавим общий 10с потолок.
	sendCtx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()

	if err := pr.Send(sendCtx, j.Payload); err != nil {
		q.fail(j, err.Error(), now, false)
		return
	}

	j.Status = "done"
	j.PrintedAt = &now
	j.UpdatedAt = now
	if err := q.db.Save(j).Error; err != nil {
		log.Error().Err(err).Str("job_id", j.ID).Msg("queue: persist done failed")
	}
}

// fail помечает job ошибочным. Если attempts >= max или fatal — status='failed';
// иначе возвращаем в pending для retry.
func (q *Queue) fail(j *models.PrintJob, msg string, now time.Time, fatal bool) {
	j.Attempts++
	j.LastError = &msg
	j.UpdatedAt = now
	if fatal || j.Attempts >= q.cfg.MaxAttempts {
		j.Status = "failed"
		log.Error().Str("job_id", j.ID).Int("attempts", j.Attempts).Str("err", msg).Msg("print job failed (no more retries)")
	} else {
		j.Status = "pending"
	}
	if err := q.db.Save(j).Error; err != nil {
		log.Error().Err(err).Str("job_id", j.ID).Msg("queue: persist fail failed")
	}
}

// backoff = base * 2^attempts (exponential).
func (q *Queue) backoff(attempts int) time.Duration {
	if attempts <= 0 {
		return 0
	}
	d := q.cfg.BaseBackoff * time.Duration(math.Pow(2, float64(attempts-1)))
	if d > time.Minute*10 {
		d = time.Minute * 10
	}
	return d
}

// ─── Default router ───────────────────────────────────────────────────────

// SingleRouter — простейший router: все jobs идут в один Printer.
// Достаточно для MVP «1 ресторан = 1 принтер чеков». Для multi-printer
// (receipt + 2 station) — расширим.
type SingleRouter struct {
	P Printer
}

func (s SingleRouter) Resolve(_ *models.PrintJob) Printer { return s.P }

// MapRouter — мапа printer_id → Printer. job.PrinterID nil → fallback в Default.
type MapRouter struct {
	Printers map[string]Printer
	Default  Printer
}

func (m MapRouter) Resolve(job *models.PrintJob) Printer {
	if job.PrinterID != nil {
		if p, ok := m.Printers[*job.PrinterID]; ok {
			return p
		}
	}
	return m.Default
}

// Errors (sentinels).
var (
	ErrNotFound = errors.New("printer queue: job not found")
)
