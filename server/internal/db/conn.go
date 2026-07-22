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
	if err := migrateUp(ctx, sqlDB); err != nil {
		return err
	}
	// Self-heal схемы ПОСЛЕ goose: до-гарантируем критичные drift-опасные
	// объекты независимо от goose_db_version (см. selfheal.go — инцидент с
	// пропавшей ingredients.warehouse_id при живом goose=36).
	return EnsureCriticalSchema(ctx, gdb)
}

func migrateUp(ctx context.Context, sqlDB *sql.DB) error {
	goose.SetBaseFS(migrationFS)
	if err := goose.SetDialect("postgres"); err != nil {
		return fmt.Errorf("goose dialect: %w", err)
	}
	goose.SetLogger(gooseZerolog{})
	// WithAllowMissing — применять «пропущенные» (out-of-order) миграции вместо
	// фатального отказа.
	//
	// Зачем (инцидент 22.07.2026, касса встала после апдейта):
	// миграция 057_shift_op_account добавлена в коде ПОЗЖЕ (v3.16.132), чем
	// 059_salary_worked_days (v3.16.130). На кассах, успевших применить 059 (у
	// них goose_db_version=59), новый бинарь с файлом 057 в strict-режиме goose
	// падал: «found 1 missing migrations before current version 59: version 57».
	// Падение на старте → log.Fatal → бесконечный рестарт-луп, касса down.
	//
	// AllowMissing заставляет goose ДОприменить 057 (её DDL идемпотентен —
	// ADD COLUMN IF NOT EXISTS), а не отвергать всю миграцию. Порядок номеров у
	// этих миграций независим (057 не зависит от 058/059), поэтому применение
	// вне очереди безопасно. Дальше держим номера строго по возрастанию, но
	// защита остаётся на случай повторения.
	if err := goose.UpContext(ctx, sqlDB, "migrations", goose.WithAllowMissing()); err != nil {
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
