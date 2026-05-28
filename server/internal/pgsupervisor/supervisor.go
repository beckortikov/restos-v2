package pgsupervisor

import (
	"context"
	"fmt"
	"os"

	embeddedpostgres "github.com/fergusstrange/embedded-postgres"
	"github.com/rs/zerolog/log"

	"github.com/restos/restos-v4/server/internal/config"
)

// Supervisor управляет жизненным циклом embedded-postgres (child-процесса).
// Запускается на старте restos-server, останавливается на graceful shutdown.
type Supervisor struct {
	cfg *config.Config
	pg  *embeddedpostgres.EmbeddedPostgres
}

// New создаёт supervisor, но НЕ запускает Postgres. Старт — через Start().
func New(cfg *config.Config) (*Supervisor, error) {
	if err := os.MkdirAll(cfg.PGDataDir(), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir pgdata: %w", err)
	}
	if err := os.MkdirAll(cfg.PGRuntimeDir(), 0o755); err != nil {
		return nil, fmt.Errorf("mkdir pg-runtime: %w", err)
	}

	pgVer, err := mapVersion(cfg.PGVersion)
	if err != nil {
		return nil, err
	}

	pg := embeddedpostgres.NewDatabase(embeddedpostgres.DefaultConfig().
		Version(pgVer).
		Username(cfg.PGUser).
		Password(cfg.PGPassword).
		Database(cfg.PGDatabase).
		Port(cfg.PGPort).
		DataPath(cfg.PGDataDir()).
		RuntimePath(cfg.PGRuntimeDir()).
		BinariesPath(cfg.PGRuntimeDir()).
		Logger(newPGLogger()))

	return &Supervisor{cfg: cfg, pg: pg}, nil
}

// Start блокирующе инициализирует и запускает Postgres.
// При первом запуске скачивает дистрибутив (~80 МБ) в RuntimePath.
func (s *Supervisor) Start(ctx context.Context) error {
	log.Info().
		Str("data_dir", s.cfg.PGDataDir()).
		Uint32("port", s.cfg.PGPort).
		Str("version", s.cfg.PGVersion).
		Msg("starting embedded-postgres")

	if err := s.pg.Start(); err != nil {
		return fmt.Errorf("embedded-postgres start: %w", err)
	}
	log.Info().Msg("embedded-postgres started")
	return nil
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
