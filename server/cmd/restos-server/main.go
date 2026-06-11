// restos-server — Go-бэк RestOS v4.
//
// Жизненный цикл:
//  1. Парсим конфиг (env + CLI).
//  2. Если ExternalPGDSN не задан — поднимаем embedded-postgres как child-процесс.
//  3. Открываем GORM-подключение, применяем миграции (goose).
//  4. Слушаем HTTP на 127.0.0.1:3001.
//  5. На SIGINT/SIGTERM — graceful: сначала HTTP, потом embedded-postgres.
package main

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/rs/zerolog"
	"github.com/rs/zerolog/log"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/config"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/jobs"
	"github.com/restos/restos-v4/server/internal/pgsupervisor"
	"github.com/restos/restos-v4/server/internal/pkg/license"
	"github.com/restos/restos-v4/server/internal/printer"
	"github.com/restos/restos-v4/server/internal/service"
	httpx "github.com/restos/restos-v4/server/internal/transport/http"
	"github.com/restos/restos-v4/server/internal/transport/sse"
)

// Заполняются через ldflags: -X main.version=... -X main.commit=... -X main.buildTime=...
var (
	version   = "dev"
	commit    = "none"
	buildTime = "unknown"
)

func main() {
	cfg, err := config.LoadFromFlags()
	if err != nil {
		// zerolog ещё не настроен — fall back на stderr.
		os.Stderr.WriteString("config error: " + err.Error() + "\n")
		os.Exit(2)
	}

	setupLogger(cfg.LogLevel)
	log.Info().
		Str("version", version).
		Str("commit", commit).
		Str("build_time", buildTime).
		Str("http_addr", cfg.HTTPAddr).
		Bool("embedded_pg", cfg.ExternalPGDSN == "").
		Str("data_dir", cfg.DataDir).
		Msg("starting restos-server")

	// Главный контекст — отменяется на SIGINT/SIGTERM.
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	// 1. Embedded Postgres (если нужен).
	// v2.7.2: keychain mechanism восстановлен. Если existing pg-data
	// был создан с другим паролем (legacy "restos" из v2.5.0 или старый
	// keychain-gen из v2.6.x на другом юзере) → start fails с auth error
	// → WIPE pg-data + re-init с новым pwd. Это destructive (теряются
	// заказы / меню / настройки), но кассир дал явное согласие на reset
	// для свежей лицензии.
	if cfg.ExternalPGDSN == "" {
		if pwd, source, err := config.ResolvePGPassword(cfg.PGPassword); err != nil {
			log.Warn().Err(err).Msg("pg password: keychain unavailable, using fallback from env/flag")
		} else {
			cfg.PGPassword = pwd
			log.Info().Str("source", source).Msg("pg password resolved")
		}
	}
	var sup *pgsupervisor.Supervisor
	if cfg.ExternalPGDSN == "" {
		sup, err = pgsupervisor.New(cfg)
		if err != nil {
			log.Fatal().Err(err).Msg("pgsupervisor.New")
		}
		startErr := sup.Start(ctx)
		if startErr != nil {
			// v2.7.2: проверка на password mismatch. Embedded-postgres
			// при auth fail обычно дает "password authentication failed"
			// или зависает в start. Wipe data-dir и retry с keychain-pwd.
			log.Warn().Err(startErr).Msg("embedded-postgres start failed — trying wipe & re-init")
			_ = sup.Stop()
			dataDir := cfg.PGDataDir()
			if rmErr := os.RemoveAll(dataDir); rmErr != nil {
				log.Fatal().Err(rmErr).Str("dir", dataDir).Msg("failed to wipe stale pg-data dir")
			}
			log.Info().Str("dir", dataDir).Msg("pg-data dir wiped; re-initializing with keychain password")
			sup, err = pgsupervisor.New(cfg)
			if err != nil {
				log.Fatal().Err(err).Msg("pgsupervisor.New (retry)")
			}
			if err := sup.Start(ctx); err != nil {
				log.Fatal().Err(err).Msg("embedded-postgres start failed after wipe — manual intervention required")
			}
		}
		defer func() {
			if err := sup.Stop(); err != nil {
				log.Error().Err(err).Msg("embedded-postgres stop failed")
			}
		}()
	} else {
		log.Info().Str("dsn", maskDSN(cfg.ExternalPGDSN)).Msg("using external Postgres")
	}

	// 2. GORM + миграции.
	gdb, err := db.Open(cfg.ActiveDSN())
	if err != nil {
		log.Fatal().Err(err).Msg("db.Open")
	}
	if err := db.MigrateUp(ctx, gdb); err != nil {
		log.Fatal().Err(err).Msg("migrations failed")
	}

	// Audit worker — async writer для audit_log. Должен стартовать ДО первой
	// мутации (т.е. до запуска HTTP-сервера). Останавливается при shutdown.
	audit.StartWorker(gdb)

	// 3. HTTP. License pubkey декодируем (если задан).
	var licPub []byte
	if cfg.LicensePublicKey != "" {
		key, err := license.DecodePublicKey(cfg.LicensePublicKey)
		if err != nil {
			log.Fatal().Err(err).Msg("bad --license-public-key")
		}
		licPub = key
		log.Info().Msg("license verification enabled")
	} else {
		log.Warn().Msg("license-public-key not set — running in dev mode (no license enforcement)")
	}

	// SSE hub — единый для router'а и background-watcher'ов.
	hub := sse.NewHub(30 * time.Second)
	pub := service.NewEventPublisher(hub)

	// License watcher: пересчитывает state каждые 60с и публикует переходы в hub.
	if licPub != nil {
		licSvcForWatcher := service.NewLicenseService(gdb, licPub).WithPublisher(pub)
		go service.NewLicenseWatcher(licSvcForWatcher, time.Minute).Run(ctx)
	}

	// NTP checker (v2.6.0): каждые 6 часов опрашивает pool.ntp.org и
	// сохраняет drift в shared-структуру. Доступно через /license/clock-status.
	ntpChecker := jobs.NewNTPChecker()
	go ntpChecker.Run(ctx)

	srv := &http.Server{
		Addr: cfg.HTTPAddr,
		Handler: httpx.NewRouter(httpx.Deps{
			DB: gdb,
			Build: httpx.BuildInfo{
				Version:   version,
				Commit:    commit,
				BuildTime: buildTime,
			},
			LicensePublicKey: licPub,
			Hub:              hub,
			NTPChecker:       ntpChecker,
			BackupCfg: service.BackupServiceConfig{
				BackupsDir:   cfg.BackupsDir(),
				DesktopDir:   cfg.DesktopBackupsDir(),
				PGRuntimeDir: cfg.PGRuntimeDir(),
				DSN:          cfg.ActiveDSN(),
				PGUser:       cfg.PGUser,
				PGPassword:   cfg.PGPassword,
				PGDatabase:   cfg.PGDatabase,
				PGHost:       "127.0.0.1",
				PGPort:       cfg.PGPort,
			},
		}),
		ReadHeaderTimeout: 10 * time.Second,
	}
	_ = pub // используется в router'е через тот же hub

	serverErr := make(chan error, 1)
	go func() {
		log.Info().Str("addr", cfg.HTTPAddr).Msg("HTTP listening")
		if err := srv.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			serverErr <- err
		}
	}()

	// Backup scheduler — фоновая goroutine, останавливается по ctx.Done().
	// Запускаем только если pg_dump доступен в PATH (мягкая проверка).
	go jobs.Scheduler(ctx, jobs.BackupConfig{
		OutputDir: cfg.BackupsDir(),
		DSN:       cfg.ActiveDSN(),
	}, nil)

	// Print queue worker.
	//
	// Router: сначала смотрит в БД-табл `printers` (настройки Manager-а), затем
	// fallback в Virtual-printer, который пишет .escpos в data-dir/print —
	// чтобы close_order не падал, пока админ не настроил реальный принтер.
	virtualFallback := printer.NewVirtual(cfg.BackupsDir() + "/print")
	router := printer.NewDBRouter(gdb, virtualFallback)
	log.Info().Str("fallback", virtualFallback.Name()).Msg("print queue: router ready")
	printQueue := printer.NewQueue(gdb, router, printer.QueueConfig{})
	go printQueue.Run(ctx)

	// Orders cleanup watchdog (v2.1.2) — каждые 5 минут чистит zombie-заказы
	// (status=active, 0 живых items) и освобождает столы. Подстраховка к
	// invariant из orders_void.go.
	go jobs.OrdersCleanupScheduler(ctx, gdb, jobs.OrdersCleanupConfig{})

	// 4. Ждём сигнал или ошибку HTTP.
	select {
	case <-ctx.Done():
		log.Info().Msg("shutdown signal received")
	case err := <-serverErr:
		log.Error().Err(err).Msg("HTTP server error")
	}

	// 5. Graceful shutdown — даём активным запросам завершиться.
	shutdownCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if err := srv.Shutdown(shutdownCtx); err != nil {
		log.Error().Err(err).Msg("HTTP shutdown")
	}
	log.Info().Msg("HTTP stopped")
	// Audit worker — даём ему 5 сек слить оставшиеся события.
	audit.StopWorker(5 * time.Second)
	log.Info().Msg("audit worker stopped")
	// embedded-postgres stop вызовется через defer.
}

func setupLogger(level string) {
	zerolog.TimeFieldFormat = time.RFC3339
	lvl, err := zerolog.ParseLevel(level)
	if err != nil || lvl == zerolog.NoLevel {
		lvl = zerolog.InfoLevel
	}
	zerolog.SetGlobalLevel(lvl)
	// Консольный вывод в dev; для prod структурированный JSON можно включить через env.
	if os.Getenv("RESTOS_LOG_JSON") == "1" {
		log.Logger = zerolog.New(os.Stderr).With().Timestamp().Logger()
	} else {
		log.Logger = log.Output(zerolog.ConsoleWriter{Out: os.Stderr, TimeFormat: time.RFC3339})
	}
}

// maskDSN убирает password=... из DSN перед записью в лог.
func maskDSN(dsn string) string {
	parts := strings.Fields(dsn)
	for i, p := range parts {
		if strings.HasPrefix(p, "password=") {
			parts[i] = "password=***"
		}
	}
	return strings.Join(parts, " ")
}
