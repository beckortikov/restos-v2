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
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/jobs"
	"github.com/restos/restos-v4/server/internal/pgsupervisor"
	"github.com/restos/restos-v4/server/internal/pkg/license"
	"github.com/restos/restos-v4/server/internal/printer"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/synclog"
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
		// ⛔ НИКОГДА не удаляем pgdata автоматически при ошибке старта.
		//
		// Раньше здесь был «wipe & re-init»: при ЛЮБОЙ ошибке sup.Start()
		// (включая ТРАНЗИТОРНУЮ — «process already listening on port 54330» от
		// зомби-Postgres, пережившего авто-апдейт) выполнялся os.RemoveAll(pgdata)
		// → полное УНИЧТОЖЕНИЕ базы кассы. Именно это стёрло данные ресторану
		// (инцидент 2026-07-14: миграция 035 упала → crash → рестарт → порт занят
		// старым PG → wipe). Автоматическое удаление данных недопустимо ни при
		// каких обстоятельствах.
		//
		// Теперь при ошибке — фатальный выход БЕЗ удаления. Electron перезапустит
		// sidecar, а его killStaleSidecars/ensurePortFree (v3.16.58) освободят
		// порт от зомби-процессов. Данные остаются нетронутыми. Реальный
		// password-mismatch (ради чего wipe и вводили) — редкость и требует
		// РУЧНОГО вмешательства с бэкапом, а не тихого сноса базы.
		if startErr := sup.Start(ctx); startErr != nil {
			_ = sup.Stop()
			log.Fatal().Err(startErr).
				Msg("embedded-postgres не запустился — выход БЕЗ удаления данных; Electron перезапустит sidecar")
		}
		defer func() {
			if err := sup.Stop(); err != nil {
				log.Error().Err(err).Msg("embedded-postgres stop failed")
			}
		}()
	} else {
		log.Info().Str("dsn", maskDSN(cfg.ExternalPGDSN)).Msg("using external Postgres")
	}

	// fatalStopPG — фатальный выход, но СНАЧАЛА останавливаем embedded-postgres.
	//
	// log.Fatal вызывает os.Exit, который НЕ выполняет defer'ы — включая
	// defer sup.Stop() выше. Значит, если мы упадём ПОСЛЕ успешного старта PG
	// (например, на миграции), запущенный embedded-postgres останется висеть на
	// порту 54330. Тогда КАЖДЫЙ следующий рестарт sidecar'а от Electron будет
	// падать с «process already listening on port 54330» — касса не поднимется
	// уже никогда (инцидент 22.07.2026: goose-ошибка на миграции осиротила PG,
	// касса ушла в вечный рестарт-луп). Явный Stop освобождает порт, и
	// перезапущенный sidecar стартует с чистого листа.
	//
	// sup == nil при external-PG (там ничего не поднимали) — тогда просто Fatal.
	fatalStopPG := func(err error, msg string) {
		if sup != nil {
			if stopErr := sup.Stop(); stopErr != nil {
				log.Error().Err(stopErr).Msg("embedded-postgres stop before fatal exit failed")
			}
		}
		log.Fatal().Err(err).Msg(msg)
	}

	// 2. GORM + миграции.
	gdb, err := db.Open(cfg.ActiveDSN())
	if err != nil {
		fatalStopPG(err, "db.Open")
	}
	if err := db.MigrateUp(ctx, gdb); err != nil {
		fatalStopPG(err, "migrations failed")
	}

	// Audit worker — async writer для audit_log. Должен стартовать ДО первой
	// мутации (т.е. до запуска HTTP-сервера). Останавливается при shutdown.
	audit.StartWorker(gdb)

	// Конфиг sync из БД (UI-настройки) перекрывает env — чтобы настроить sync из
	// приложения, а не только флагами. Читаем ДО сборки роутера (deps.SyncToken)
	// и запуска пушера. Меняется в UI → применяется после перезапуска.
	//
	// needsAutoBackfill (Ф6): backfilled_at — маркер «история уже отправлена»,
	// ОТДЕЛЬНЫЙ от Enabled — persisted-флаг Enabled остаётся true при КАЖДОМ
	// рестарте после первого включения, по нему одному нельзя отличить «sync
	// только что включили» от «обычный рестарт уже синхронизирующейся кассы».
	// ss.BackfilledAt == nil одинаково верно и для «строки ещё нет» (свежий
	// CLI-flag-only конфиг), и для «строка есть, но забфилл не запускали» —
	// оба случая должны запустить автозабфилл один раз.
	var needsAutoBackfill bool
	{
		var ss models.SyncSettings
		if err := gdb.Where("id = 1").First(&ss).Error; err == nil {
			cfg.SyncEnabled = ss.Enabled
			if ss.CentralURL != nil {
				cfg.SyncCentralURL = *ss.CentralURL
			}
			if ss.Token != nil {
				cfg.SyncToken = *ss.Token
			}
			if ss.RestaurantID != nil {
				cfg.SyncRestaurantID = *ss.RestaurantID
			}
			if ss.IntervalSec > 0 {
				cfg.SyncIntervalSec = ss.IntervalSec
			}
		}
		needsAutoBackfill = ss.BackfilledAt == nil
	}

	// Запись дельт в sync_log включаем только если этот узел синхронизируется
	// (роль branch с настроенным пушером). Иначе автономный режим не копит журнал.
	synclog.SetEnabled(cfg.SyncEnabled)

	// 3. HTTP. License pubkey декодируем (если задан).
	var licPub []byte
	if cfg.LicensePublicKey != "" {
		key, err := license.DecodePublicKey(cfg.LicensePublicKey)
		if err != nil {
			fatalStopPG(err, "bad --license-public-key")
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
			LicensePublicKey:    licPub,
			Hub:                 hub,
			NTPChecker:          ntpChecker,
			WaiterAPKPath:       cfg.WaiterAppPath(),
			SyncToken:           cfg.SyncToken,
			ZakupAPKPath:        cfg.ZakupAppPath(),
			AttendancePhotosDir: cfg.AttendancePhotosDir(),
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

	// Ротация журнала синка (Фаза О, ADR-003) — раз в сутки удаляет УЖЕ
	// ОТПРАВЛЕННЫЕ дельты старше 30 дней. Неотправленное и карантинное не
	// трогает никогда. Стартует безусловно: журнал мог накопиться, пока
	// ресторан был в сети, и продолжать расти после отключения синка.
	go jobs.SyncLogRotateScheduler(ctx, gdb, jobs.SyncLogRotateConfig{})

	// Ретенция селфи отметок (103): чистим оригиналы старше 90 дней, превью в
	// БД остаются. Store поднимаем отдельно от роутера — джобе нужен только он.
	go jobs.AttendancePhotoPurgeScheduler(
		ctx,
		service.NewAttendancePhotoStore(repo.New(gdb), cfg.AttendancePhotosDir()),
		jobs.AttendancePhotoPurgeConfig{},
	)

	// Multi-branch sync pusher/puller (Фаза 2, ADR-003; безрестартовое
	// подключение — ADR-003 продолжение). Стартуют БЕЗУСЛОВНО, даже если sync
	// сейчас выключен/не настроен — каждый тик сам перечитывает sync_settings
	// и решает, есть ли что делать (Pusher.activeConfig/Puller.activeConfig).
	// Так подключение по коду приглашения (JoinNetwork) подхватывается без
	// перезапуска процесса — раньше эта горутина вообще не создавалась, пока
	// sync не был настроен ДО старта.
	interval := time.Duration(cfg.SyncIntervalSec) * time.Second
	if interval <= 0 {
		interval = 30 * time.Second
	}
	// Fallback из boot-cfg (env/CLI RESTOS_SYNC_*) — на случай headless-узла,
	// у которого строки sync_settings нет вообще (документированный env-путь).
	// Как только строка в БД появляется — она побеждает на каждом тике.
	pusher := synclog.NewPusher(repo.New(gdb), synclog.FallbackConfig{
		CentralURL: cfg.SyncCentralURL, Token: cfg.SyncToken, Enabled: cfg.SyncEnabled,
	})
	go pusher.Run(ctx, interval)
	puller := service.NewPuller(service.NewSyncService(repo.New(gdb)), repo.New(gdb), service.PullerFallback{
		CentralURL: cfg.SyncCentralURL, Token: cfg.SyncToken,
		RestaurantID: cfg.SyncRestaurantID, Enabled: cfg.SyncEnabled,
	})
	go puller.Run(ctx, interval)

	// Delivery relay puller (091) — central пробивает заказ доставки ЗА
	// филиал, этот процесс его материализует через ordersSvc.Create +
	// PrintPreBill. Отдельный от Pusher/Puller выше: короткий интервал
	// (default 5с — заказ должен начать готовиться сразу, не ждать общего
	// 30-секундного цикла sync_log), читает ТУ ЖЕ sync_settings. Свой
	// OrdersService (не из httpx.NewRouter — тот инкапсулирован внутри) с
	// тем же hub/pub, чтобы материализованный заказ публиковал события SSE
	// как любой другой (KDS/кухонные дисплеи должны увидеть его штатно).
	deliveryInterval := time.Duration(cfg.DeliveryRelayIntervalSec) * time.Second
	if deliveryInterval <= 0 {
		deliveryInterval = 5 * time.Second
	}
	deliveryOrdersSvc := service.NewOrdersService(repo.New(gdb)).
		WithPublisher(pub).
		WithStationResolver(printer.NewDBRouter(gdb, nil))
	deliveryPuller := service.NewDeliveryPuller(deliveryOrdersSvc, repo.New(gdb), service.PullerFallback{
		CentralURL: cfg.SyncCentralURL, Token: cfg.SyncToken,
		RestaurantID: cfg.SyncRestaurantID, Enabled: cfg.SyncEnabled,
	})
	go deliveryPuller.Run(ctx, deliveryInterval)

	// Employee relay puller (097) — central управляет персоналом филиала;
	// этот процесс материализует команду через настоящие UsersService.
	// Create/Patch/SalaryService.SetWorkedDays/ToggleDayMultiplier. Интервал
	// длиннее delivery (default 30с — HR не курьерская срочность), читает ТУ
	// ЖЕ sync_settings. Свои Users/SalaryService (не из httpx.NewRouter — тот
	// инкапсулирован внутри), SSE им не нужен — ни один, ни другой его не
	// публикуют и в router.go тоже конструируются без WithPublisher.
	employeeInterval := time.Duration(cfg.EmployeeRelayIntervalSec) * time.Second
	if employeeInterval <= 0 {
		employeeInterval = 30 * time.Second
	}
	employeePuller := service.NewEmployeeRelayPuller(
		service.NewUsersService(repo.New(gdb)),
		service.NewSalaryService(repo.New(gdb)),
		// График смен (104) материализуется тем же настоящим сервисом, что и
		// локальные правки менеджера — фото-хранилище ему не нужно, оно
		// участвует только в перекличке.
		service.NewScheduleService(repo.New(gdb), nil),
		repo.New(gdb),
		service.PullerFallback{
			CentralURL: cfg.SyncCentralURL, Token: cfg.SyncToken,
			RestaurantID: cfg.SyncRestaurantID, Enabled: cfg.SyncEnabled,
		},
	)
	go employeePuller.Run(ctx, employeeInterval)

	// Автозабфилл истории при старте (Ф6, ADR-003 «Central видит всё») — для
	// узла, который УЖЕ был настроен на sync до этого запуска (переменные
	// окружения/сохранённый sync_settings), но ещё ни разу не отправлял
	// историю. Симметричный триггер для «подключились ПРЯМО СЕЙЧАС кодом
	// приглашения, без рестарта» — в JoinNetwork (network_invites.go), тем
	// же вызовом Backfill+пометкой backfilled_at.
	if needsAutoBackfill && cfg.SyncEnabled && cfg.SyncRestaurantID != "" {
		go func() {
			bctx := audit.WithActor(context.Background(), audit.Actor{UserName: "system", Role: "owner"})
			syncSvc := service.NewSyncService(repo.New(gdb))
			res, err := syncSvc.Backfill(bctx, cfg.SyncRestaurantID)
			if err != nil {
				log.Error().Err(err).Msg("sync backfill (auto, первое включение): failed")
				return
			}
			log.Info().Interface("entities", res.Entities).Msg("sync backfill (auto, первое включение): completed")
			// Гвард от гонки с тиком Pusher.activeConfig: если recorder оказался
			// выключен ВО ВРЕМЯ забфилла (Record no-op'ил → часть истории не
			// записалась), backfilled_at НЕ помечаем — следующий старт честно
			// повторит забфилл (ingest на central идемпотентен по row_id).
			if !synclog.Enabled() {
				log.Error().Msg("sync backfill: recorder выключился во время забфилла — backfilled_at не помечаю, повторится при следующем старте")
				return
			}
			now := time.Now().UTC()
			upd := gdb.Model(&models.SyncSettings{}).Where("id = 1").Update("backfilled_at", now)
			if upd.Error == nil && upd.RowsAffected == 0 {
				// Строки sync_settings ещё не было (CLI-flag-only конфиг,
				// без UI) — материализуем её со ЗНАЧЕНИЯМИ ИЗ cfg, а не
				// пустыми полями: иначе следующий рестарт прочитал бы
				// новую строку с enabled=false по умолчанию и ВЫКЛЮЧИЛ
				// бы sync, который сейчас реально работал через флаги.
				central, token, ridCopy := cfg.SyncCentralURL, cfg.SyncToken, cfg.SyncRestaurantID
				if err := gdb.Create(&models.SyncSettings{
					ID: 1, Enabled: cfg.SyncEnabled, CentralURL: &central, Token: &token,
					RestaurantID: &ridCopy, IntervalSec: cfg.SyncIntervalSec, BackfilledAt: &now,
				}).Error; err != nil {
					log.Error().Err(err).Msg("sync backfill: failed to persist sync_settings row")
				}
			} else if upd.Error != nil {
				log.Error().Err(upd.Error).Msg("sync backfill: failed to mark backfilled_at")
			}
		}()
	}

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
