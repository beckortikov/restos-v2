package http

import (
	"context"
	"crypto/ed25519"
	"encoding/json"
	"net/http"
	"os"
	"strings"
	"sync/atomic"
	"time"

	"github.com/go-chi/chi/v5"
	chimw "github.com/go-chi/chi/v5/middleware"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/jobs"
	"github.com/restos/restos-v4/server/internal/printer"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/handlers"
	"github.com/restos/restos-v4/server/internal/transport/http/middleware"
	"github.com/restos/restos-v4/server/internal/transport/sse"
)

// Deps — зависимости HTTP-слоя.
type Deps struct {
	DB               *gorm.DB
	Build            BuildInfo
	LicensePublicKey ed25519.PublicKey // nil → лицензия не проверяется (dev)
	// Hub — опциональный SSE hub. Если nil → создаётся внутренний (без watcher'ов).
	// Чтобы запустить background-сервисы (LicenseWatcher) поверх того же hub'а,
	// main создаёт hub сам и передаёт сюда.
	Hub *sse.Hub
	// NTPChecker — singleton с последним результатом NTP-проверки.
	// Если nil → /license/clock-status вернёт empty status.
	NTPChecker *jobs.NTPChecker
	// BackupCfg — пути/DSN для ручного backup/restore через UI. Если
	// BackupsDir пуст — endpoints вернут ошибку (dev без embedded PG).
	BackupCfg service.BackupServiceConfig
	// WaiterAPKPath — путь к загруженному APK официанта (раздаётся по QR/LAN).
	// Пусто → раздача/загрузка APK недоступна (dev/тест без DataDir).
	WaiterAPKPath string
	// SyncToken — общий секрет сети для межузлового auth /sync/* (Фаза 3).
	// Пусто → /sync/* закрыт (узел не участвует в multi-branch sync).
	SyncToken string
}

// BuildInfo пробрасывается из main для GET /healthz.
type BuildInfo struct {
	Version   string
	Commit    string
	BuildTime string
}

// NewRouter собирает chi-роутер.
//
// Структура:
//   - /healthz, /readyz — публичные, без auth
//   - /api/v1/auth/login — публичный
//   - /api/v1/* — защищены Bearer-токеном (middleware.Auth)
//   - /api/v1/events — SSE, тоже с auth
func NewRouter(deps Deps) http.Handler {
	r := chi.NewRouter()
	r.Use(chimw.RealIP)
	r.Use(chimw.RequestID)
	r.Use(chimw.Recoverer)
	r.Use(middleware.CORS(corsOriginsFromEnv()))
	// 30-секундный таймаут НЕ применяем к SSE-эндпоинту — он long-lived.
	// Применяем только к /api/v1/auth и /api/v1/<resource>, оставляя /events
	// без таймаута.

	r.Get("/healthz", func(w http.ResponseWriter, req *http.Request) {
		writeJSON(w, http.StatusOK, map[string]any{
			"status":     "ok",
			"version":    deps.Build.Version,
			"commit":     deps.Build.Commit,
			"build_time": deps.Build.BuildTime,
		})
	})

	r.Get("/readyz", func(w http.ResponseWriter, req *http.Request) {
		ctx, cancel := context.WithTimeout(req.Context(), 3*time.Second)
		defer cancel()
		if err := db.Ping(ctx, deps.DB); err != nil {
			writeJSON(w, http.StatusServiceUnavailable, map[string]any{
				"status": "db_unavailable",
				"error":  err.Error(),
			})
			return
		}
		writeJSON(w, http.StatusOK, map[string]any{"status": "ready"})
	})

	// Wire services.
	rep := repo.New(deps.DB)
	authSvc := service.NewAuthService(deps.DB)
	idemSvc := service.NewIdempotencyService(deps.DB)
	menuSvc := service.NewMenuService(rep)
	tablesSvc := service.NewTablesService(rep)
	stockSvc := service.NewStockService(rep)
	shiftsSvc := service.NewShiftsService(rep)
	hub := deps.Hub
	if hub == nil {
		hub = sse.NewHub(30 * time.Second)
	}
	pub := service.NewEventPublisher(hub)
	// Stations resolver — DBRouter ищет принтер по station.
	stations := printer.NewDBRouter(deps.DB, nil)
	ordersSvc := service.NewOrdersService(rep).WithPublisher(pub).WithStationResolver(stations)
	shiftsSvc = shiftsSvc.WithPublisher(pub)
	stockSvc = stockSvc.WithPublisher(pub)
	inventorySvc := service.NewInventoryService(rep)
	printersSvc := service.NewPrintersService(rep)
	printJobsSvc := service.NewPrintJobsService(rep)
	importSvc := service.NewImportService(rep)
	reportsSvc := service.NewReportsService(rep)
	licenseSvc := service.NewLicenseService(deps.DB, deps.LicensePublicKey).WithPublisher(pub)
	shadowSvc := service.NewShadowService(rep)
	usersSvc := service.NewUsersService(rep)
	customersSvc := service.NewCustomersService(rep)
	suppliersSvc := service.NewSuppliersService(rep)
	reservationsSvc := service.NewReservationsService(rep)
	restaurantSvc := service.NewRestaurantService(rep)
	bootstrapSvc := service.NewBootstrapService(rep)
	assetsSvc := service.NewAssetsService(rep)
	liabilitiesSvc := service.NewLiabilitiesService(rep)
	equitySvc := service.NewEquityService(rep)
	budgetSvc := service.NewBudgetService(rep)
	timeEntriesSvc := service.NewTimeEntriesService(rep)
	modGroupsSvc := service.NewModifierGroupsService(rep)
	modsSvc := service.NewModifiersService(rep)
	techCardsSvc := service.NewTechCardsService(rep)
	semiSvc := service.NewSemiFinishedService(rep)
	zonesWriteSvc := service.NewZonesWriteService(rep)
	tablesWriteSvc := service.NewTablesWriteService(rep).WithPublisher(pub)
	restaurantsSvc := service.NewRestaurantsService(rep)
	ingredientsWriteSvc := service.NewIngredientsWriteService(rep)
	stockReadsSvc := service.NewStockReadsService(rep)
	inventoryReadsSvc := service.NewInventoryReadsService(rep)
	supplyExpensesSvc := service.NewSupplyExpensesService(rep)
	finAccountsSvc := service.NewFinancialAccountsService(rep)
	finOpsSvc := service.NewFinancialOperationsService(rep)
	customCatsSvc := service.NewCustomCategoriesService(rep)
	finReportsSvc := service.NewFinanceReportsService(rep)
	analyticsSvc := service.NewAnalyticsService(rep)
	trendsSvc := service.NewTrendsService(reportsSvc, finReportsSvc)
	waiterAppSvc := service.NewWaiterAppService(deps.WaiterAPKPath)
	salarySvc := service.NewSalaryService(rep)
	stopListSvc := service.NewStopListService(rep)
	insightsSvc := service.NewInsightsService(rep, analyticsSvc, stopListSvc)
	batchSvc := service.NewBatchCookingService(rep)
	auditReadsSvc := service.NewAuditReadsService(rep)

	authH := handlers.NewAuth(authSvc, deps.DB)
	menuH := handlers.NewMenu(menuSvc)
	tablesH := handlers.NewTables(tablesSvc)
	stockH := handlers.NewStock(stockSvc)
	transfersH := handlers.NewTransfers(service.NewTransferService(rep))
	networkH := handlers.NewNetwork(service.NewNetworkService(rep))
	syncH := handlers.NewSync(service.NewSyncService(rep))
	shiftsH := handlers.NewShifts(shiftsSvc)
	ordersH := handlers.NewOrders(ordersSvc)
	inventoryH := handlers.NewInventory(inventorySvc)
	printersH := handlers.NewPrinters(printersSvc)
	printJobsH := handlers.NewPrintJobs(printJobsSvc)
	importH := handlers.NewImport(importSvc)
	reportsH := handlers.NewReports(reportsSvc)
	licenseH := handlers.NewLicense(licenseSvc).WithNTP(deps.NTPChecker)
	shadowH := handlers.NewShadow(shadowSvc)
	usersH := handlers.NewUsers(usersSvc)
	customersH := handlers.NewCustomers(customersSvc)
	suppliersH := handlers.NewSuppliers(suppliersSvc)
	reservationsH := handlers.NewReservations(reservationsSvc)
	restaurantH := handlers.NewRestaurant(restaurantSvc)
	bootstrapH := handlers.NewBootstrap(bootstrapSvc)
	assetsH := handlers.NewAssets(assetsSvc)
	liabilitiesH := handlers.NewLiabilities(liabilitiesSvc)
	equityH := handlers.NewEquity(equitySvc)
	budgetH := handlers.NewBudget(budgetSvc)
	timeEntriesH := handlers.NewTimeEntries(timeEntriesSvc)
	modGroupsH := handlers.NewModifierGroups(modGroupsSvc)
	modsH := handlers.NewModifiers(modsSvc)
	techCardsH := handlers.NewTechCards(techCardsSvc)
	semiH := handlers.NewSemiFinished(semiSvc)
	zonesWriteH := handlers.NewZonesWrite(zonesWriteSvc)
	tablesWriteH := handlers.NewTablesWrite(tablesWriteSvc)
	restaurantsH := handlers.NewRestaurants(restaurantsSvc)
	ingredientsWriteH := handlers.NewIngredientsWrite(ingredientsWriteSvc)
	stockReadsH := handlers.NewStockReads(stockReadsSvc)
	inventoryReadsH := handlers.NewInventoryReads(inventoryReadsSvc)
	supplyExpensesH := handlers.NewSupplyExpenses(supplyExpensesSvc)
	finAccountsH := handlers.NewFinancialAccounts(finAccountsSvc)
	finOpsH := handlers.NewFinancialOperations(finOpsSvc)
	customCatsH := handlers.NewCustomCategories(customCatsSvc)
	finReportsH := handlers.NewFinanceReports(finReportsSvc)
	analyticsH := handlers.NewAnalytics(analyticsSvc)
	trendsH := handlers.NewTrends(trendsSvc)
	insightsH := handlers.NewInsights(insightsSvc)
	waiterAppH := handlers.NewWaiterApp(waiterAppSvc)
	salaryH := handlers.NewSalary(salarySvc)
	stopListH := handlers.NewStopList(stopListSvc)
	batchH := handlers.NewBatchCooking(batchSvc)
	auditReadsH := handlers.NewAuditReads(auditReadsSvc)
	waiterStatsH := handlers.NewWaiterStats(timeEntriesSvc)
	eventsH := handlers.NewEvents(hub)
	// maintFlag — взводится BackupService на время restore. Пока взведён,
	// middleware.Maintenance отдаёт 503 на все запросы кроме /backup и /events,
	// чтобы pg_restore --clean смог взять эксклюзивные блокировки на таблицы.
	var maintFlag atomic.Bool
	backupSvc := service.NewBackupService(deps.BackupCfg).WithDB(deps.DB).WithMaintenance(&maintFlag)
	backupH := handlers.NewBackup(backupSvc)
	// v3.9.1: авто-бэкап при закрытии смены. Только если BackupsDir
	// сконфигурирован (прод с embedded PG) — в тестах nil-cfg → пропускаем.
	if deps.BackupCfg.BackupsDir != "" {
		shiftsSvc = shiftsSvc.WithBackup(backupSvc)
	}

	r.Route("/api/v1", func(api chi.Router) {
		// Maintenance-страж: во время restore все запросы кроме /backup и
		// /events получают 503, чтобы не держать блокировки на таблицах.
		api.Use(middleware.Maintenance(&maintFlag))

		// Публичные endpoint'ы (login + bootstrap).
		api.Group(func(g chi.Router) {
			g.Use(chimw.Timeout(10 * time.Second))
			g.Post("/auth/login", authH.Login)
			// Bootstrap — первичная инициализация, без auth. Защищён внутри: только
			// если restaurants пустая. Status — read-check для фронта (показать
			// форму bootstrap или login).
			g.Get("/bootstrap/status", bootstrapH.Status)
			g.Post("/bootstrap", bootstrapH.Run)
			// Public probe для onboarding Kotlin APK / Electron — позволяет
			// клиенту убедиться, что http://<host>:3001 — это RestOS v4, до
			// логина. Возвращает {machine_id, restaurant_id, restaurant_name}.
			g.Get("/public/machine-info", licenseH.PublicMachineInfo)
			g.Post("/users/validate-pin", usersH.ValidatePIN)
		})

		// Защищённые endpoints с обычным таймаутом.
		api.Group(func(g chi.Router) {
			g.Use(chimw.Timeout(30 * time.Second))
			g.Use(middleware.Auth(authSvc))
			// Владелец сети может смотреть GET-отчёты «как филиал X» (X-Branch-Id).
			g.Use(middleware.BranchOverride(deps.DB))

			g.Post("/auth/logout", authH.Logout)

			g.Get("/menu/items", menuH.ListItems)
			g.Get("/menu/categories", menuH.ListCategories)

			g.Get("/zones", tablesH.ListZones)
			g.Get("/tables", tablesH.ListTables)

			g.Get("/stock/ingredients", stockH.ListIngredients)
			g.Get("/stock/ingredient-categories", stockReadsH.ListCategories)
			g.Get("/stock/receipts", stockReadsH.ListReceipts)
			g.Get("/stock/writeoffs", stockReadsH.ListWriteoffs)
			g.Get("/stock/movements", stockReadsH.ListMovements)
			g.Get("/stock/transfers", transfersH.List)
			g.Get("/stock/transfers/{id}", transfersH.Get)
			g.Get("/network/branches", networkH.ListBranches)
			g.Get("/network/summary", networkH.Summary)
			g.Get("/nomenclature", networkH.ListNomenclature)
			g.Get("/stock/inventory", inventoryReadsH.List)
			g.Get("/stock/inventory/{id}", inventoryReadsH.Get)
			g.Get("/stock/inventory/{id}/lines", inventoryReadsH.ListLines)
			g.Get("/supply-expenses", supplyExpensesH.List)

			g.Get("/shifts", shiftsH.List)
			g.Get("/shifts/active", shiftsH.Active)
			g.Get("/shifts/{id}", shiftsH.Get)
			g.Get("/shifts/{id}/zreport", shiftsH.ZReport)
			g.Get("/shifts/{id}/revenue", shiftsH.Revenue)
			g.Get("/shifts/{id}/operations", shiftsH.Operations)

			g.Get("/orders", ordersH.List)
			g.Get("/orders/{id}", ordersH.Get)
			g.Get("/order-items/{id}", ordersH.GetItem)
			g.Get("/orders/{id}/splits", ordersH.ListSplits)
			g.Get("/orders/{id}/voids", ordersH.ListVoidsByOrder)
			g.Get("/voids", ordersH.ListVoids)

			// Admin: принтеры и очередь — read-only через эту же группу.
			g.Get("/printers", printersH.List)
			g.Get("/printers/{id}", printersH.Get)
			g.Get("/print/jobs", printJobsH.List)
			g.Get("/print/jobs/active-by-station", printJobsH.ActiveByStation)

			// Reports — XLSX download (read-only, потоковые).
			g.Get("/reports/orders.xlsx", reportsH.Orders)
			g.Get("/reports/shifts/{id}.xlsx", reportsH.Shift)
			g.Get("/reports/stock-movements.xlsx", reportsH.StockMovements)
			g.Get("/reports/audit.xlsx", reportsH.Audit)
			g.Get("/reports/pl.xlsx", reportsH.PnL)

			// License — status + activate + machine-id доступны даже в locked.
			g.Get("/license/status", licenseH.Status)
			g.Get("/license/machine-id", licenseH.MachineInfo)
			g.Get("/license/clock-status", licenseH.ClockStatus)
			g.Post("/license/activate", licenseH.Activate)

			// Shadow (Phase 8): batch-приём drift-репортов + агрегаты для Owner Dashboard.
			// reports — POST но не пишет доменные данные (metrics), Idempotency не нужен.
			g.Post("/admin/shadow/reports", shadowH.Ingest)
			g.Get("/admin/shadow/stats", shadowH.Stats)
			g.Get("/admin/shadow/drifts", shadowH.RecentDrifts)

			// Admin CRUD (reads + restaurant.get).
			g.Get("/users", usersH.List)
			g.Get("/users/{id}", usersH.Get)
			g.Get("/customers", customersH.List)
			g.Get("/suppliers", suppliersH.List)
			g.Get("/reservations", reservationsH.List)
			g.Get("/restaurant", restaurantH.Get)

			// Finance + Payroll + Menu extras + Semi (reads).
			g.Get("/assets", assetsH.List)
			g.Get("/liabilities", liabilitiesH.List)
			g.Get("/equity", equityH.List)
			g.Get("/budget", budgetH.List)
			g.Get("/time-entries", timeEntriesH.List)
			g.Get("/menu/modifier-groups", modGroupsH.List)
			g.Get("/menu/modifiers", modsH.List)
			g.Get("/menu/tech-cards", techCardsH.List)
			g.Get("/semi/types", semiH.ListTypes)
			g.Get("/semi/types/{id}", semiH.GetType)
			g.Get("/semi/stock", semiH.ListStock)

			// Stop-list (compute-on-read).
			g.Get("/stop-list", stopListH.List)

			// Batch cooking reads.
			g.Get("/menu/items/{id}/max-portions", batchH.MaxPortions)
			g.Get("/menu/batch/availability", batchH.Availability)
			g.Get("/menu/items/{id}/batch/logs", batchH.Logs)
			g.Get("/menu/batch/logs", batchH.LogsCross)

			// Audit reads.
			g.Get("/audit-log", auditReadsH.List)

			// Reservations extras.
			g.Get("/reservations/for-table/{table_id}", reservationsH.ForTable)

			// Time entries / waiter stats extras.
			g.Get("/time-entries/active", timeEntriesH.Active)
			g.Get("/waiters/{id}/today-stats", waiterStatsH.TodayStats)

			// Finance: accounts, operations, custom categories, JSON reports, service accrual/payout.
			g.Get("/finance/accounts", finAccountsH.List)
			g.Get("/finance/operations", finOpsH.List)
			g.Get("/finance/custom-categories", customCatsH.List)
			g.Get("/finance/pnl", finReportsH.PnL)
			g.Get("/finance/cashflow", finReportsH.Cashflow)
			g.Get("/finance/balance", finReportsH.Balance)
			g.Get("/finance/monthly-revenue", finReportsH.MonthlyRevenue)

			// Analytics aggregates — Phase 3.2, серверные отчёты для /analytics/*.
			g.Get("/analytics/abc-menu", analyticsH.ABCMenu)
			g.Get("/analytics/peak-hours", analyticsH.PeakHours)
			g.Get("/analytics/weekday", analyticsH.Weekday)
			g.Get("/analytics/waiters", analyticsH.Waiters)
			g.Get("/analytics/tables", analyticsH.Tables)
			g.Get("/analytics/food-cost", analyticsH.FoodCost)
			g.Get("/analytics/food-cost/monthly", analyticsH.FoodCostMonthly)
			g.Get("/analytics/ingredient-stock-value", analyticsH.IngredientStockValue)
			g.Get("/analytics/trends", trendsH.Trends)
			g.Get("/analytics/trends.xlsx", trendsH.Export)
			g.Get("/analytics/insights", insightsH.Insights)

			// APK официанта — состояние + загрузка нового (раздача по QR — публично).
			g.Get("/waiter-app", waiterAppH.Info)
			g.Post("/waiter-app", waiterAppH.Upload)
			g.Get("/analytics/forecast", analyticsH.Forecast)
			g.Get("/analytics/abc-inventory", analyticsH.ABCInventory)
			g.Get("/finance/service-accrual/by-waiter", salaryH.AccrualByWaiter)
			g.Get("/finance/service-accrual/by-shift/{shift_id}", salaryH.AccrualByShift)
			g.Get("/finance/service-payout/by-waiter", salaryH.PayoutByWaiter)
			g.Get("/finance/service-payout/by-shift/{shift_id}", salaryH.PayoutByShift)

			// Restaurants (global, Phase 10).
			g.Get("/restaurants", restaurantsH.List)
			g.Get("/restaurants/{id}", restaurantsH.Get)
			g.Get("/restaurants/{id}/stats", restaurantsH.Stats)

			// Backup — list/download read-only.
			g.Get("/backup/list", backupH.List)
			g.Get("/backup/download/{name}", backupH.Download)
		})

		// Imports + Backup — multipart / долгие операции, без Idempotency.
		// Таймаут 5 минут: pg_dump/pg_restore большой БД может занять время.
		api.Group(func(g chi.Router) {
			g.Use(chimw.Timeout(5 * time.Minute))
			g.Use(middleware.Auth(authSvc))
			if deps.LicensePublicKey != nil {
				g.Use(middleware.LicenseRequired(licenseSvc))
			}

			g.Post("/menu/items/import", importH.MenuItems)
			g.Post("/stock/ingredients/import", importH.Ingredients)
			g.Post("/users/import", importH.Users)
			g.Post("/tables/import", importH.Tables)

			// Backup — create / restore / delete.
			g.Post("/backup/create", backupH.Create)
			g.Post("/backup/restore", backupH.RestoreUpload)
			g.Post("/backup/{name}/restore", backupH.RestoreExisting)
			g.Delete("/backup/{name}", backupH.Delete)
		})

		// Write-эндпоинты — Auth + License + Idempotency.
		// Межузловой sync (multi-branch, ADR-003 Фаза 3) — свой auth по общему
		// секрету сети, НЕ user-сессия. Пушер/пуллер филиала ходят сюда.
		api.Group(func(g chi.Router) {
			g.Use(chimw.Timeout(60 * time.Second))
			g.Use(middleware.SyncAuth(deps.SyncToken))
			g.Post("/sync/ingest", syncH.Ingest)
			g.Get("/sync/pull", syncH.Pull)
		})

		api.Group(func(g chi.Router) {
			g.Use(chimw.Timeout(30 * time.Second))
			g.Use(middleware.Auth(authSvc))
			if deps.LicensePublicKey != nil {
				g.Use(middleware.LicenseRequired(licenseSvc))
			}
			g.Use(middleware.Idempotency(idemSvc))

			g.Post("/orders", ordersH.Create)
			g.Post("/orders/{id}/items", ordersH.AddItems)
			g.Post("/orders/{id}/close", ordersH.Close)
			g.Post("/orders/{id}/cancel", ordersH.Cancel)
			g.Post("/orders/{id}/refund", ordersH.Refund)
			g.Post("/orders/{id}/reprint-receipt", ordersH.ReprintReceipt)
			g.Post("/orders/{id}/items/{itemId}/void", ordersH.VoidItem)
			g.Post("/orders/{id}/split", ordersH.Split)
			g.Post("/orders/{id}/transfer", ordersH.Transfer)
			// Splits management
			g.Post("/orders/{id}/splits/equal", ordersH.SplitEqual)
			g.Post("/orders/{id}/splits/by-items", ordersH.SplitByItems)
			g.Post("/orders/{id}/splits/cancel", ordersH.CancelSplits)
			g.Post("/splits/{split_id}/pay", ordersH.PaySplit)
			g.Post("/orders/{id}/check-and-close", ordersH.CheckAndClose)
			// Voids
			g.Post("/voids", ordersH.CreateVoid)
			// Item lifecycle
			g.Post("/orders/{id}/items/{itemId}/cancel", ordersH.CancelItem)
			g.Post("/orders/{id}/items/{itemId}/served", ordersH.MarkServed)
			g.Delete("/orders/{id}/items/{itemId}/served", ordersH.UnmarkServed)
			g.Patch("/orders/{id}/items/{itemId}/note", ordersH.SetItemNote)
			g.Post("/orders/{id}/print-pre-bill", ordersH.PrintPreBill)
			g.Post("/orders/{id}/items/{itemId}/claim-print", ordersH.ClaimPrint)
			g.Post("/orders/{id}/items/{itemId}/release-print", ordersH.ReleasePrint)
			g.Post("/orders/{id}/items/{itemId}/claim-cancel-print", ordersH.ClaimCancelPrint)
			g.Post("/orders/{id}/items/{itemId}/release-cancel-print", ordersH.ReleaseCancelPrint)
			// Order ops
			g.Post("/orders/{id}/reopen", ordersH.Reopen)
			g.Post("/orders/{id}/table", ordersH.MoveTable)
			// Phase 18: partial PATCH + status transitions.
			g.Patch("/orders/{id}", ordersH.Patch)
			g.Post("/orders/{id}/start-cooking", ordersH.StartCooking)
			g.Post("/orders/{id}/mark-ready", ordersH.MarkOrderReady)
			g.Post("/orders/{id}/mark-served", ordersH.MarkOrderServed)
			// Jobs
			g.Post("/orders/auto-ready/check", ordersH.AutoReadyCheck)
			g.Post("/admin/cleanup/orphan-orders", ordersH.CleanupOrphans)

			g.Post("/shifts", shiftsH.Open)
			g.Patch("/shifts/{id}", shiftsH.UpdateAccount)
			g.Post("/shifts/{id}/close", shiftsH.Close)
			g.Post("/shifts/{id}/operations", shiftsH.AddOperation)
			g.Post("/shifts/{id}/expenses", shiftsH.AddExpense)
			g.Delete("/shifts/{id}/expenses/{op_id}", shiftsH.DeleteExpense)
			g.Delete("/cash-shift-operations/{id}", shiftsH.DeleteOperationByID)
			g.Post("/shifts/{id}/print-z", shiftsH.PrintZ)
			g.Post("/shifts/{id}/print-x", shiftsH.PrintX)
			g.Post("/shifts/{id}/print-service", shiftsH.PrintService)

			g.Post("/stock/receipts", stockH.CreateReceipt)
			g.Post("/stock/receipts/{id}/confirm", stockH.ConfirmReceipt)
			g.Post("/stock/writeoffs", stockH.CreateWriteoff)
			g.Post("/stock/transfers", transfersH.Create)
			g.Post("/stock/transfers/{id}/receive", transfersH.Receive)
			g.Post("/network", networkH.CreateNetwork)
			g.Post("/network/branches/{id}/kind", networkH.SetBranchKind)
			g.Post("/nomenclature", networkH.CreateNomenclature)
			g.Post("/stock/ingredients/{id}/nomenclature", networkH.LinkIngredient)
			g.Post("/stock/opening-balance", stockH.OpeningBalance)
			g.Post("/stock/inventory", inventoryH.Create)
			g.Post("/stock/inventory/{id}/apply", inventoryH.Apply)
			g.Post("/stock/ingredients", ingredientsWriteH.Create)
			g.Patch("/stock/ingredients/{id}", ingredientsWriteH.Patch)
			g.Delete("/stock/ingredients/{id}", ingredientsWriteH.Delete)
			g.Post("/supply-expenses", supplyExpensesH.Create)

			g.Post("/menu/items", menuH.CreateItem)
			g.Patch("/menu/items/{id}", menuH.PatchItem)
			g.Delete("/menu/items/{id}", menuH.DeleteItem)
			g.Post("/menu/categories", menuH.CreateCategory)
			g.Patch("/menu/categories/{id}", menuH.PatchCategory)
			g.Delete("/menu/categories/{id}", menuH.DeleteCategory)

			// Admin: printers CRUD + print queue retry + test page.
			g.Post("/printers", printersH.Create)
			g.Patch("/printers/{id}", printersH.Patch)
			// PUT — алиас PATCH для совместимости с клиентами, посылающими PUT
			// (v2.0.93: некоторые формы slept до миграции на PATCH).
			g.Put("/printers/{id}", printersH.Patch)
			g.Delete("/printers/{id}", printersH.Delete)
			g.Post("/printers/{id}/test", printersH.Test)
			g.Post("/print/jobs/{id}/retry", printJobsH.Retry)
			g.Post("/print/jobs/{id}/dismiss", printJobsH.Dismiss)

			// Admin CRUD: users, customers, suppliers, reservations, restaurant.
			g.Post("/users", usersH.Create)
			g.Post("/users/generate-pin", usersH.GeneratePIN)
			g.Patch("/users/{id}", usersH.Patch)
			g.Delete("/users/{id}", usersH.Delete)
			g.Post("/customers", customersH.Create)
			g.Patch("/customers/{id}", customersH.Patch)
			g.Post("/customers/{id}/stats", customersH.IncrementStats)
			g.Delete("/customers/{id}", customersH.Delete)
			g.Post("/suppliers", suppliersH.Create)
			g.Patch("/suppliers/{id}", suppliersH.Patch)
			g.Delete("/suppliers/{id}", suppliersH.Delete)
			g.Post("/reservations", reservationsH.Create)
			g.Patch("/reservations/{id}", reservationsH.Patch)
			g.Post("/reservations/{id}/status", reservationsH.PatchStatus)
			g.Delete("/reservations/{id}", reservationsH.Delete)
			g.Patch("/restaurant", restaurantH.Patch)

			// Finance CRUDs.
			g.Post("/assets", assetsH.Create)
			g.Patch("/assets/{id}", assetsH.Patch)
			g.Delete("/assets/{id}", assetsH.Delete)
			g.Post("/liabilities", liabilitiesH.Create)
			g.Patch("/liabilities/{id}", liabilitiesH.Patch)
			g.Delete("/liabilities/{id}", liabilitiesH.Delete)
			g.Post("/equity", equityH.Create)
			g.Patch("/equity/{id}", equityH.Patch)
			g.Delete("/equity/{id}", equityH.Delete)
			g.Post("/budget", budgetH.Create)
			g.Patch("/budget/{id}", budgetH.Patch)
			g.Delete("/budget/{id}", budgetH.Delete)

			// Payroll: ClockIn/ClockOut/Delete.
			g.Post("/time-entries", timeEntriesH.ClockIn)
			g.Patch("/time-entries/{id}/clock-out", timeEntriesH.ClockOut)
			g.Delete("/time-entries/{id}", timeEntriesH.Delete)

			// Menu extras: Modifier groups + modifiers + tech cards.
			g.Post("/menu/modifier-groups", modGroupsH.Create)
			g.Patch("/menu/modifier-groups/{id}", modGroupsH.Patch)
			g.Delete("/menu/modifier-groups/{id}", modGroupsH.Delete)
			g.Post("/menu/modifiers", modsH.Create)
			g.Patch("/menu/modifiers/{id}", modsH.Patch)
			g.Delete("/menu/modifiers/{id}", modsH.Delete)
			g.Post("/menu/tech-cards", techCardsH.Create)
			g.Patch("/menu/tech-cards/{id}", techCardsH.Patch)
			g.Delete("/menu/tech-cards/{id}", techCardsH.Delete)

			// SemiFinished types.
			g.Post("/semi/types", semiH.CreateType)
			g.Patch("/semi/types/{id}", semiH.PatchType)
			g.Delete("/semi/types/{id}", semiH.DeleteType)
			g.Post("/semi/prepare", semiH.Prepare)
			g.Post("/semi/consume", semiH.Consume)

			// Stop-list overrides.
			g.Post("/stop-list/{menu_item_id}/override", stopListH.SetOverride)
			g.Post("/stop-list/recompute", stopListH.Recompute)

			// Batch cooking writes.
			g.Post("/menu/items/{id}/batch/produce", batchH.Produce)
			g.Post("/menu/items/{id}/batch/decrement", batchH.Decrement)
			g.Post("/menu/items/{id}/batch/writeoff", batchH.Writeoff)

			// Print reprint.
			g.Post("/print/jobs/{id}/reprint", printJobsH.Reprint)

			// Time entries patch.
			g.Patch("/time-entries/{id}", timeEntriesH.Patch)

			// Zones write (Phase 10).
			g.Post("/zones", zonesWriteH.Create)
			g.Patch("/zones/{id}", zonesWriteH.Patch)
			g.Delete("/zones/{id}", zonesWriteH.Delete)

			// Tables write (Phase 10).
			g.Post("/tables", tablesWriteH.Create)
			g.Patch("/tables/{id}", tablesWriteH.Patch)
			g.Delete("/tables/{id}", tablesWriteH.Delete)
			g.Patch("/tables/{id}/status", tablesWriteH.SetStatus)
			g.Post("/tables/{id}/assign-waiter", tablesWriteH.AssignWaiter)
			g.Post("/tables/{id}/open-for-order", tablesWriteH.OpenForOrder)
			g.Post("/tables/merge", tablesWriteH.Merge)
			g.Post("/tables/{id}/unmerge", tablesWriteH.Unmerge)
			g.Post("/admin/cleanup/stuck-tables", tablesWriteH.CleanupStuck)

			// Finance: accounts CRUD + transfer.
			g.Post("/finance/accounts", finAccountsH.Create)
			g.Patch("/finance/accounts/{id}", finAccountsH.Patch)
			g.Delete("/finance/accounts/{id}", finAccountsH.Delete)
			g.Post("/finance/accounts/transfer", finAccountsH.Transfer)
			g.Post("/finance/operations", finOpsH.Create)
			g.Post("/finance/custom-categories", customCatsH.Create)
			g.Delete("/finance/custom-categories/{id}", customCatsH.Delete)
			g.Post("/finance/salary/pay", salaryH.PaySalary)
			g.Post("/finance/service-charge/pay", salaryH.PayServiceCharge)

			// Restaurants write (Phase 10).
			g.Post("/restaurants", restaurantsH.Create)
			g.Patch("/restaurants/{id}", restaurantsH.Patch)
			g.Delete("/restaurants/{id}", restaurantsH.Delete)
			g.Post("/restaurants/{id}/clear-operations", restaurantsH.ClearOperations)
			g.Post("/restaurants/{id}/clear-menu", restaurantsH.ClearMenu)
			g.Post("/restaurants/{id}/seed", restaurantsH.SeedDemo)
		})

		// SSE — отдельная группа без таймаута (long-lived).
		api.Group(func(g chi.Router) {
			g.Use(middleware.Auth(authSvc))
			g.Get("/events", eventsH.Stream)
		})
	})

	// Статические Excel-шаблоны импорта — вшиты в бинарь напрямую (docs.go),
	// независимо от embed-spa pipeline. Явный роут с честным 404 на miss,
	// чтобы скачивание шаблона никогда не отдавало SPA index.html под видом
	// .xlsx (иначе Excel: «формат или расширение не являются допустимыми»).
	r.Handle("/docs/*", DocsHandler())

	// APK официанта — ПУБЛИЧНО (телефон качает по QR ещё до логина). Вне
	// /api/v1 и до SPA-fallback, чтобы NotFound не перехватил.
	r.Get(service.WaiterAppDownloadPath, waiterAppH.Download)

	// SPA static — отдаёт embedded React build на всех не-API путях.
	// Любой браузер в LAN, открывший http://<касса-ip>:3001, получает UI.
	// См. spa.go.
	spa := SPAHandler()
	r.NotFound(spa.ServeHTTP)

	return r
}

func writeJSON(w http.ResponseWriter, code int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(code)
	_ = json.NewEncoder(w).Encode(body)
}

// corsOriginsFromEnv читает RESTOS_CORS_ALLOWED_ORIGINS=csv,list или
// возвращает дефолтные dev-origins (Vite на 3000/5173).
func corsOriginsFromEnv() []string {
	csv := strings.TrimSpace(os.Getenv("RESTOS_CORS_ALLOWED_ORIGINS"))
	if csv == "" {
		return []string{
			"http://localhost:3000", "http://127.0.0.1:3000",
			"http://localhost:5173", "http://127.0.0.1:5173",
		}
	}
	parts := strings.Split(csv, ",")
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}
