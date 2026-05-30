package config

import (
	"flag"
	"fmt"
	"os"
	"path/filepath"
)

// Config — runtime-параметры restos-server.
//
// Источники (в порядке приоритета): CLI flags → env → defaults.
// CLI flags задаются в LoadFromFlags; env читается там же при отсутствии флага.
type Config struct {
	// HTTP listen address (chi router).
	HTTPAddr string

	// Если задан — Go-бэк подключается к external Postgres и НЕ запускает embedded-postgres.
	// Для dev. В проде на машине кассира — пусто, поднимаем embedded.
	ExternalPGDSN string

	// Корень для embedded-postgres: data dir, runtime, логи, бэкапы.
	// По умолчанию — userData/restos (на macOS ~/Library/Application Support/restos).
	DataDir string

	// Версия Postgres для embedded-дистрибутива.
	PGVersion string

	// Порт embedded-postgres (localhost-only).
	PGPort uint32

	// Логин/пароль для embedded-postgres (не критично, БД слушает только loopback).
	PGUser     string
	PGPassword string
	PGDatabase string

	// Уровень логирования (debug|info|warn|error).
	LogLevel string

	// LicensePublicKey — base64-encoded Ed25519 public key для проверки
	// license-токенов. Если пусто → активация лицензии недоступна
	// (dev/bootstrap режим: write работает без license-middleware).
	LicensePublicKey string
}

// LoadFromFlags парсит CLI флаги и переменные окружения.
// Вызывается ровно один раз из main.
func LoadFromFlags() (*Config, error) {
	c := &Config{}

	// Default to 0.0.0.0 so the Kotlin APK officianta can reach the sidecar
	// over LAN (cashier exposes http://<lan-ip>:3001 in the QR). Electron
	// still fetches via 127.0.0.1:3001 — both interfaces are bound.
	flag.StringVar(&c.HTTPAddr, "http-addr", envOr("RESTOS_HTTP_ADDR", "0.0.0.0:3001"),
		"HTTP listen address")
	flag.StringVar(&c.ExternalPGDSN, "external-pg-dsn", envOr("RESTOS_EXTERNAL_PG_DSN", ""),
		"External Postgres DSN (dev only). If set, embedded-postgres is not started.")
	flag.StringVar(&c.DataDir, "data-dir", envOr("RESTOS_DATA_DIR", defaultDataDir()),
		"Data directory root (pgdata, backups, logs)")
	flag.StringVar(&c.PGVersion, "pg-version", envOr("RESTOS_PG_VERSION", "16.4.0"),
		"Embedded Postgres version")
	flag.StringVar(&c.LogLevel, "log-level", envOr("RESTOS_LOG_LEVEL", "info"),
		"Log level: debug|info|warn|error")
	flag.StringVar(&c.LicensePublicKey, "license-public-key", envOr("RESTOS_LICENSE_PUBLIC_KEY", ""),
		"Base64-encoded Ed25519 public key for license verification (empty = dev mode)")

	var pgPort uint
	flag.UintVar(&pgPort, "pg-port", uint(envOrUint("RESTOS_PG_PORT", 54329)),
		"Embedded Postgres port (loopback only)")

	flag.StringVar(&c.PGUser, "pg-user", envOr("RESTOS_PG_USER", "restos"), "Embedded PG user")
	flag.StringVar(&c.PGPassword, "pg-password", envOr("RESTOS_PG_PASSWORD", "restos"), "Embedded PG password")
	flag.StringVar(&c.PGDatabase, "pg-database", envOr("RESTOS_PG_DATABASE", "restos"), "Embedded PG database")

	flag.Parse()

	c.PGPort = uint32(pgPort)

	if c.DataDir == "" {
		return nil, fmt.Errorf("data-dir is required")
	}
	return c, nil
}

// PGDataDir — каталог с физическими файлами Postgres.
func (c *Config) PGDataDir() string { return filepath.Join(c.DataDir, "pgdata") }

// PGRuntimeDir — каталог, куда распаковывается дистрибутив embedded-postgres.
func (c *Config) PGRuntimeDir() string { return filepath.Join(c.DataDir, "pg-runtime") }

// BackupsDir — каталог для pg_dump-бэкапов.
func (c *Config) BackupsDir() string { return filepath.Join(c.DataDir, "backups") }

// EmbeddedDSN — DSN для подключения к локальному embedded-postgres.
func (c *Config) EmbeddedDSN() string {
	return fmt.Sprintf("host=127.0.0.1 port=%d user=%s password=%s dbname=%s sslmode=disable",
		c.PGPort, c.PGUser, c.PGPassword, c.PGDatabase)
}

// ActiveDSN — DSN для GORM. External имеет приоритет.
func (c *Config) ActiveDSN() string {
	if c.ExternalPGDSN != "" {
		return c.ExternalPGDSN
	}
	return c.EmbeddedDSN()
}

func defaultDataDir() string {
	if d := os.Getenv("RESTOS_DATA_DIR"); d != "" {
		return d
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return filepath.Join(".", "restos-data")
	}
	// Унификация: всегда кладём под ~/.restos, чтобы и dev и prod видели одно и то же.
	// В Electron prod-сборке мы переопределим через --data-dir на app.getPath('userData').
	return filepath.Join(home, ".restos")
}

func envOr(key, def string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return def
}

func envOrUint(key string, def uint) uint {
	v := os.Getenv(key)
	if v == "" {
		return def
	}
	var out uint
	if _, err := fmt.Sscanf(v, "%d", &out); err != nil {
		return def
	}
	return out
}
