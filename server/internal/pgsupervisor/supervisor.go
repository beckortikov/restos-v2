package pgsupervisor

import (
	"context"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"time"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
	"github.com/rs/zerolog/log"

	"github.com/restos/restos-v4/server/internal/config"
)

// Supervisor управляет жизненным циклом embedded-postgres (child-процесса).
// Запускается на старте restos-server, останавливается на graceful shutdown.
type Supervisor struct {
	cfg    *config.Config
	binDir string // каталог распакованных бинарей (cfg.PGBinariesDir())
	pg     *embeddedpostgres.EmbeddedPostgres
}

// New создаёт supervisor, но НЕ запускает Postgres. Старт — через Start().
func New(cfg *config.Config) (*Supervisor, error) {
	if err := os.MkdirAll(cfg.PGDataDir(), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir pgdata: %w", err)
	}
	if err := os.MkdirAll(cfg.PGRuntimeDir(), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir pg-runtime: %w", err)
	}
	if err := os.MkdirAll(cfg.PGBinariesDir(), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir pg-bin: %w", err)
	}

	s := &Supervisor{cfg: cfg, binDir: cfg.PGBinariesDir()}
	pg, err := s.buildPG()
	if err != nil {
		return nil, err
	}
	s.pg = pg
	return s, nil
}

// buildPG собирает свежий инстанс embedded-postgres из конфига. Вынесено, чтобы
// пересобрать инстанс для повторной попытки старта после сброса бинарей.
func (s *Supervisor) buildPG() (*embeddedpostgres.EmbeddedPostgres, error) {
	pgVer, err := mapVersion(s.cfg.PGVersion)
	if err != nil {
		return nil, err
	}
	return embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Version(pgVer).
		Username(s.cfg.PGUser).
		Password(s.cfg.PGPassword).
		Database(s.cfg.PGDatabase).
		Port(s.cfg.PGPort).
		DataPath(s.cfg.PGDataDir()).
		RuntimePath(s.cfg.PGRuntimeDir()).
		// BinariesPath ОТДЕЛЬНО от RuntimePath: библиотека стирает RuntimePath на
		// каждом Start(), а бинари должны переживать старт (иначе распаковка 133 МБ
		// каждый запуск). См. config.PGBinariesDir.
		BinariesPath(s.binDir).
		// Дефолт embedded-postgres — 15 с. Этого мало для ХОЛОДНОГО старта после
		// авто-апдейта: WAL-recovery после нечистого выключения (форс-килл старого
		// PG при апдейте), скан бинаря антивирусом при ПЕРВОЙ распаковке, холодный
		// дисковый кэш — легко превышают 15 с → «backend не запустился». Даём 90 с.
		StartTimeout(90 * time.Second).
		Logger(newPGLogger())), nil
}

// clearStaleLock удаляет устаревший pgdata/postmaster.pid, ОСТАВШИЙСЯ от
// нечистого выключения (после авто-апдейта старый PG форс-килят, lock остаётся).
// Такой lock заставляет pg_ctl отказать в старте или зависнуть. Удаляем ТОЛЬКО
// если порт PG молчит (значит живого PG нет) — чтобы не убить реально
// работающий сервер. Безопасно при любом способе запуска (dev/electron).
func (s *Supervisor) clearStaleLock() {
	lock := filepath.Join(s.cfg.PGDataDir(), "postmaster.pid")
	if _, err := os.Stat(lock); err != nil {
		return // lock-файла нет — чистить нечего
	}
	addr := fmt.Sprintf("127.0.0.1:%d", s.cfg.PGPort)
	if c, err := net.DialTimeout("tcp", addr, 500*time.Millisecond); err == nil {
		_ = c.Close()
		return // порт отвечает → PG жив, lock НЕ трогаем
	}
	if err := os.Remove(lock); err != nil {
		log.Warn().Err(err).Str("lock", lock).Msg("не удалось удалить устаревший postmaster.pid")
		return
	}
	log.Info().Msg("удалён устаревший postmaster.pid (восстановление после нечистого выключения)")
}

// Start блокирующе инициализирует и запускает Postgres.
// При первом запуске скачивает дистрибутив (~80 МБ) в RuntimePath.
func (s *Supervisor) Start(ctx context.Context) error {
	log.Info().
		Str("data_dir", s.cfg.PGDataDir()).
		Uint32("port", s.cfg.PGPort).
		Str("version", s.cfg.PGVersion).
		Msg("starting embedded-postgres")

	// Чистим устаревший lock ДО старта — иначе pg_ctl может зависнуть/отказать
	// после нечистого выключения (типичный сценарий после авто-апдейта).
	s.clearStaleLock()

	if err := s.pg.Start(); err != nil {
		// Первый старт упал. Частая причина после разведения бинарей в отдельный
		// каталог — недокачанная/битая/сожранная антивирусом распаковка в pg-bin
		// (раньше самолечилось тем, что бинари распаковывались ЗАНОВО каждый
		// старт). Восстанавливаем это самолечение точечно: сбрасываем ТОЛЬКО
		// каталог бинарей и делаем ОДНУ чистую распаковку + повторный старт.
		//
		// ⛔ pgdata при этом НЕ трогаем НИКОГДА (CLAUDE.md: авто-снос данных
		// недопустим). wipeBinaries удаляет исключительно pg-bin/<version>.
		log.Warn().Err(err).Msg("embedded-postgres start упал — сброс бинарей + одна чистая распаковка (данные не трогаем)")
		s.wipeBinaries()
		s.clearStaleLock()
		pg, buildErr := s.buildPG()
		if buildErr != nil {
			return fmt.Errorf("rebuild after failed start: %w", buildErr)
		}
		s.pg = pg
		if err2 := s.pg.Start(); err2 != nil {
			return fmt.Errorf("embedded-postgres start (после чистой распаковки): %w", err2)
		}
	}
	log.Info().Msg("embedded-postgres started")
	return nil
}

// wipeBinaries удаляет ТОЛЬКО каталог распакованных бинарей (pg-bin/<version>),
// чтобы следующий старт распаковал их с нуля. Данные (pgdata) не трогаются
// никогда — защита от опечатки: не удаляем, если путь пуст или совпал с data-dir.
func (s *Supervisor) wipeBinaries() {
	if s.binDir == "" || s.binDir == s.cfg.PGDataDir() {
		log.Error().Str("binDir", s.binDir).Msg("wipeBinaries: подозрительный путь — пропускаем сброс")
		return
	}
	if err := os.RemoveAll(s.binDir); err != nil {
		log.Warn().Err(err).Str("dir", s.binDir).Msg("не удалось очистить каталог бинарей PG")
	}
}

// Stop корректно останавливает Postgres. Идемпотентен.
func (s *Supervisor) Stop() error {
	log.Info().Msg("stopping embedded-postgres")
	if err := s.pg.Stop(); err != nil {
		return fmt.Errorf("embedded-postgres stop: %w", err)
	}
	return nil
}

// mapVersion отображает строку версии "16.4.0" → embeddedpostgres.PostgresVersion.
// Поддерживаем только 16.x в MVP — соответствует ADR.
func mapVersion(v string) (embeddedpostgres.PostgresVersion, error) {
	switch v {
	case "16.4.0", "16.4", "16":
		return embeddedpostgres.V16, nil
	default:
		return "", fmt.Errorf("unsupported PG version %q (only 16.x supported)", v)
	}
}
