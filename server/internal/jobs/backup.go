// Package jobs — фоновые задачи restos-server (cron-style).
//
// Backup-job: pg_dump --format=custom в data-dir/backups, ротация:
//   - daily   — 7 последних
//   - weekly  — 4 последних
//   - monthly — 12 последних
//
// Расписание (CLAUDE.md): «ежедневно в 3:00». Мы реализуем легко тестируемым
// способом — функция RunOnce запускает один прогон, BackupScheduler в фоне
// дёргает RunOnce по таймеру.
package jobs

import (
	"context"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
)

// BackupConfig — параметры backup-job.
type BackupConfig struct {
	// Куда складывать дампы (обычно cfg.BackupsDir()).
	OutputDir string
	// DSN для pg_dump (тот же что у приложения).
	DSN string
	// Путь к бинарю pg_dump. Если пусто — ищем в PATH.
	PgDumpBin string
	// Ротация. Если 0 — отключено (для тестов).
	KeepDaily   int // default 7
	KeepWeekly  int // default 4
	KeepMonthly int // default 12
	// Now — инжектируется в тестах. Если nil — используется time.Now.
	Now func() time.Time
}

func (c *BackupConfig) defaults() {
	if c.KeepDaily == 0 {
		c.KeepDaily = 7
	}
	if c.KeepWeekly == 0 {
		c.KeepWeekly = 4
	}
	if c.KeepMonthly == 0 {
		c.KeepMonthly = 12
	}
	if c.Now == nil {
		c.Now = time.Now
	}
	if c.PgDumpBin == "" {
		c.PgDumpBin = "pg_dump"
	}
}

// RunOnce создаёт один backup и применяет ротацию.
// Возвращает путь к новому файлу.
func RunOnce(ctx context.Context, cfg BackupConfig) (string, error) {
	cfg.defaults()
	if err := os.MkdirAll(cfg.OutputDir, 0o755); err != nil {
		return "", fmt.Errorf("mkdir backups: %w", err)
	}

	now := cfg.Now()
	tier := classifyTier(now)
	fname := fmt.Sprintf("%s-%s.dump", tier, now.Format("20060102-150405"))
	fpath := filepath.Join(cfg.OutputDir, fname)

	cmd := exec.CommandContext(ctx, cfg.PgDumpBin, "--format=custom", "--file="+fpath, "--dbname="+cfg.DSN)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// Не оставляем недописанный файл.
		_ = os.Remove(fpath)
		return "", fmt.Errorf("pg_dump failed: %w (output: %s)", err, strings.TrimSpace(string(out)))
	}
	log.Info().Str("file", fpath).Msg("backup created")

	if err := rotate(cfg.OutputDir, "daily", cfg.KeepDaily); err != nil {
		log.Warn().Err(err).Msg("backup rotation daily")
	}
	if err := rotate(cfg.OutputDir, "weekly", cfg.KeepWeekly); err != nil {
		log.Warn().Err(err).Msg("backup rotation weekly")
	}
	if err := rotate(cfg.OutputDir, "monthly", cfg.KeepMonthly); err != nil {
		log.Warn().Err(err).Msg("backup rotation monthly")
	}

	return fpath, nil
}

// classifyTier решает, как назвать бэкап (daily/weekly/monthly), чтобы политика
// ротации работала. Правило простое и предсказуемое:
//   - 1-е число месяца → monthly
//   - воскресенье      → weekly
//   - остальное        → daily
//
// Это не строго «3 каскадных бэкапа в день», как делают некоторые системы — это
// один бэкап с типом, зависящим от календаря. На большинстве рестораторских
// инсталляций (1 касса = 1 БД) этого достаточно.
func classifyTier(t time.Time) string {
	if t.Day() == 1 {
		return "monthly"
	}
	if t.Weekday() == time.Sunday {
		return "weekly"
	}
	return "daily"
}

// rotate удаляет старые файлы с указанным префиксом, оставляя `keep` самых свежих.
func rotate(dir, prefix string, keep int) error {
	if keep <= 0 {
		return nil
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return err
	}
	var files []os.DirEntry
	for _, e := range entries {
		if e.IsDir() {
			continue
		}
		if strings.HasPrefix(e.Name(), prefix+"-") && strings.HasSuffix(e.Name(), ".dump") {
			files = append(files, e)
		}
	}
	if len(files) <= keep {
		return nil
	}
	// Сортируем по имени убывая — у нас имя содержит timestamp, поэтому
	// лексикографический порядок = хронологический.
	sort.Slice(files, func(i, j int) bool { return files[i].Name() > files[j].Name() })
	for _, e := range files[keep:] {
		path := filepath.Join(dir, e.Name())
		if err := os.Remove(path); err != nil {
			log.Warn().Err(err).Str("file", path).Msg("rotate: remove failed")
		} else {
			log.Info().Str("file", path).Msg("rotated out")
		}
	}
	return nil
}

// Scheduler запускает RunOnce ежедневно. Останавливается по ctx.Done().
//
// nextRunAt — функция выбора следующего времени запуска (3:00 локально).
// Сделана параметром, чтобы тесты могли подменить.
func Scheduler(ctx context.Context, cfg BackupConfig, nextRunAt func(now time.Time) time.Time) {
	cfg.defaults()
	if nextRunAt == nil {
		nextRunAt = DefaultNextRunAt
	}

	for {
		now := cfg.Now()
		next := nextRunAt(now)
		wait := next.Sub(now)
		if wait < 0 {
			wait = 0
		}
		log.Info().Time("next_at", next).Dur("wait", wait).Msg("backup scheduler: sleeping")

		select {
		case <-ctx.Done():
			return
		case <-time.After(wait):
		}

		if path, err := RunOnce(ctx, cfg); err != nil {
			log.Error().Err(err).Msg("backup run failed")
		} else {
			log.Info().Str("file", path).Msg("backup run ok")
		}
	}
}

// DefaultNextRunAt возвращает ближайшее 03:00 локального времени.
func DefaultNextRunAt(now time.Time) time.Time {
	next := time.Date(now.Year(), now.Month(), now.Day(), 3, 0, 0, 0, now.Location())
	if !next.After(now) {
		next = next.Add(24 * time.Hour)
	}
	return next
}
