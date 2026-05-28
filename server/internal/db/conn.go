package db

import (
	"context"
	"database/sql"
	"embed"
	"fmt"
	"time"

	"github.com/pressly/goose/v3"
	"github.com/rs/zerolog/log"
	"gorm.io/driver/postgres"
	"gorm.io/gorm"
	gormlogger "gorm.io/gorm/logger"

	"github.com/restos/restos-v4/server/internal/audit"
)

//go:embed migrations/*.sql
var migrationFS embed.FS

// Open открывает GORM-подключение к Postgres и настраивает connection pool по правилам CLAUDE.md.
func Open(dsn string) (*gorm.DB, error) {
	gdb, err := gorm.Open(postgres.Open(dsn), &gorm.Config{
		Logger: gormlogger.Default.LogMode(gormlogger.Warn),
		NowFunc: func() time.Time {
			return time.Now().UTC()
		},
	})
	if err != nil {
		return nil, fmt.Errorf("gorm open: %w", err)
	}

	sqlDB, err := gdb.DB()
	if err != nil {
		return nil, fmt.Errorf("gdb.DB: %w", err)
	}
	// Pool: 50 max open для запаса под параллельные транзакции (заказы создаются
	// батчами при пиковой нагрузке, плюс worker'ы — print queue, watcher).
	// Каждая Create-tx делает ~3-5 запросов внутри, при 50 параллельных это
	// уже > 100 in-flight query-slots, поэтому 25 (раньше) упиралось.
	sqlDB.SetMaxOpenConns(50)
	sqlDB.SetMaxIdleConns(10)
	sqlDB.SetConnMaxLifetime(time.Hour)

	if err := audit.Register(gdb); err != nil {
		return nil, fmt.Errorf("audit.Register: %w", err)
	}
	if err := audit.RegisterStockDenorm(gdb); err != nil {
		return nil, fmt.Errorf("audit.RegisterStockDenorm: %w", err)
	}

	return gdb, nil
}

// Ping проверяет, что БД отвечает. Используется в healthcheck.
func Ping(ctx context.Context, gdb *gorm.DB) error {
	sqlDB, err := gdb.DB()
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	return sqlDB.PingContext(ctx)
}

// MigrateUp применяет все embedded-миграции через goose.
// Идемпотентно — повторный запуск ничего не сломает.
func MigrateUp(ctx context.Context, gdb *gorm.DB) error {
	sqlDB, err := gdb.DB()
	if err != nil {
		return err
	}
	return migrateUp(ctx, sqlDB)
}

func migrateUp(ctx context.Context, sqlDB *sql.DB) error {
	goose.SetBaseFS(migrationFS)
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("goose dialect: %w", err)
	}
	goose.SetLogger(gooseZerolog{})
	if err := goose.UpContext(ctx, sqlDB, "migrations"); err != nil {
		return fmt.Errorf("goose up: %w", err)
	}
	log.Info().Msg("migrations applied")
	return nil
}

// gooseZerolog — адаптер логгера goose в zerolog.
type gooseZerolog struct{}

func (gooseZerolog) Fatalf(format string, v ...interface{}) {
	log.Fatal().Msgf(format, v...)
}
func (gooseZerolog) Printf(format string, v ...interface{}) {
	log.Info().Msgf(format, v...)
}
