package middleware

import (
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// BranchOverride — «смотреть как филиал X» для владельца сети (ADR-003 Фаза 4).
//
// Позволяет владельцу через заголовок X-Branch-Id переключить контекст на другой
// филиал СВОЕЙ сети — тогда все ForTenant-скоупленные GET-отчёты автоматически
// показывают данные этого филиала (один middleware вместо правки каждого отчёта).
//
// Жёсткие гарантии (иначе — межтенантная утечка):
//   - только GET (никаких мутаций от чужого имени);
//   - только роль owner;
//   - ТЕКУЩИЙ ресторан — central_warehouse (см. ниже, почему это критично);
//   - целевой филиал должен быть в ТОЙ ЖЕ сети (account_id совпадает и не пуст).
//
// При любом несоответствии — тихо игнорируем override (работаем как свой ресторан),
// не отдаём ошибку: заголовок опционален и не должен ломать обычные запросы.
//
// Работает осмысленно ТОЛЬКО на центральном узле: каждый филиал — своя
// отдельная Postgres (ADR-003), и данные других точек сети реплицируются
// исключительно НА central (Фаза 2/5.1). В локальной БД филиала «соседи»
// существуют лишь заглушками (для cross-node ссылок вроде to_restaurant_id) —
// без единой реальной строки бизнес-данных и, что опаснее всего, без
// license_expires_at. Переключение на такую заглушку не просто покажет
// пустые отчёты, а тенант-подменит /license/status на filial-стороне и
// уронит кассу в экран активации (нашли вживую). Поэтому override включается,
// только если ТЕКУЩИЙ ресторан — central_warehouse.

// ─── Ф7: инверсия allowlist → blocklist ────────────────────────────────────
// До Ф7 (v3.16.226-231) здесь жил `branchDataAvailable` — allowlist
// (default-deny): путь показывал данные филиала БЕЗ баннера, только если его
// построчно проверили и явно вписали. По мере фаз Ф1-Ф6 репликация выросла с
// 3 сущностей (orders/order_items/financial_operations) до 19 — allowlist
// разросся, но 79 из 124 GET-роутов оставались НЕ проверены вовсе и потому
// показывали баннер «недоступно» даже там, где данные на самом деле были
// полными и корректными (напр. /network/branches, /finance/operations,
// /menu/popularity — см. ниже). План (docs, ADR-003) требовал на финальной
// фазе инвертировать: доступно ВСЁ, кроме явного списка live-путей.
//
// branchDataBlocked — обратная семантика: путь здесь = баннер «недоступно»
// показывается. ВСЁ, чего нет в карте, теперь по умолчанию считается
// доступным. Это смещает риск: раньше забытый allow = лишний баннер (не
// опасно), теперь забытый block = тихо неверная/неполная цифра ВМЕСТО
// честного баннера. Каждая новая GET-ручка, читающая live-состояние кассы
// (карта зала, кухня, принтеры, любая нереплицированная таблица) ОБЯЗАНА
// сразу попасть сюда — самой частой ошибкой ревью теперь будет забыть это
// сделать, а не забыть добавить в allowlist.
//
// Полная построчная разведка всех 79 путей — Explore-агенты, 2026-07-31
// (4 параллельных агента по доменам: меню/склад-справочники/CRM,
// аналитика/отчёты, заказы/смены/операционные, сетевые/служебные). Единственный
// источник истины о том, что реплицируется — `sync_backfill.go`/`sync_ingest.go`
// (19 entity в обе стороны) + generic-хуки `synclog/recorder_hook.go`
// (trackedInsert/trackedSave) — ни триггеров, ни других путей записи в
// sync_log в БД нет.
//
// Ключи — CHI ROUTE PATTERN (chi.RouteContext(ctx).RoutePattern()), НЕ
// r.URL.Path: путь с параметром типа /shifts/{id} в реальном запросе всегда
// содержит подставленный UUID, а не литерал "{id}" — сверка по r.URL.Path
// никогда бы не совпала (баг, найден при добавлении первых параметризованных
// путей в Ф1). RoutePattern() уже разрешён на этот момент (проверено —
// middleware выполняется ПОСЛЕ того, как chi нашёл маршрут) и включает полный
// префикс /api/v1. Матчинг — по ВСЕМУ паттерну, без учёта query-параметров:
// выборочно запретить только один `?include=`/`?status=` для одного и того же
// пути middleware не умеет (тот же принцип, что раньше сформулирован для
// /finance/pnl vs /reports/pl.xlsx) — если хоть один режим пути читает
// нереплицированное или живое состояние, блокируется путь целиком.
var branchDataBlocked = map[string]bool{
	// ─── Заказы и живая операционка кассы ──────────────────────────────────
	// recordOrderSync вызывается ТОЛЬКО из терминальных точек (Close/Cancel/
	// VoidItem/Refund/PaySplit-autoclose, см. sync_orders.go) — нетерминальные
	// (new/cooking/ready/served) на central физически не существуют.
	"/api/v1/orders":             true, // ?status=new/open — central даст правдоподобно ПУСТОЙ список активных вместо баннера
	"/api/v1/orders/{id}":        true, // для нетерминального id — тихий 404 вместо честного «не реплицируется»; для терминального был бы корректен, но паттерн общий
	"/api/v1/order-items/{id}":   true, // тот же JOIN на orders — тот же 404-паттерн
	"/api/v1/orders/{id}/splits": true, // order_splits вне плана репликации (сознательно, см. план — «живая операционка»)
	"/api/v1/orders/{id}/voids":  true, // order_voids вне плана репликации
	"/api/v1/voids":              true, // order_voids вне плана репликации
	"/api/v1/kds/items":          true, // фильтр status NOT IN ('done','served','cancelled') — ровно нетерминальные
	"/api/v1/kds/stations":       true, // технически безопасен (только menu_items), блокируем для консистентности — список станций бессмыслен без самой доски KDS
	// /tables — НЕ найден в исходной разведке 4 агентов (те проверяли только
	// /analytics/tables), обнаружен отдельно при финальной сверке: TablesService.
	// ListTables отдаёт models.Table целиком, включая status/current_order_id/
	// opened_at/waiter_id — из Ф2 эти поля НЕ реплицируются (только structural
	// CRUD, SetStatus/AssignWaiter/OpenForOrder — живая операционка кассы).
	// ?status=occupied дал бы тот же класс риска, что /orders?status=new. Zones
	// (models.Zone) такого живого поля не несёт вовсе — безопасен по умолчанию.
	"/api/v1/tables": true,

	// ─── Печать/принтеры — железо КОНКРЕТНОЙ кассы, вне плана репликации ───
	"/api/v1/printers":                     true,
	"/api/v1/printers/{id}":                true,
	"/api/v1/printers/system-queues":       true, // вообще не tenant-scoped (комментарий в коде: «список снимается с машины, где крутится Go-бэк») — под override показал бы очереди central, а не филиала
	"/api/v1/print/jobs":                   true,
	"/api/v1/print/jobs/active-by-station": true,

	// ─── Стоп-лист — живое состояние кухни прямо сейчас ────────────────────
	// Ручные стопы (menu_items) были бы корректны, но авто-стоп по нехватке
	// сырья джойнит tech_card_lines (не реплицируется) — список тихо теряет
	// часть строк, не просто пуст целиком (тот же корень, что у
	// /analytics/insights ниже).
	"/api/v1/stop-list": true,

	// ─── Диагностика shadow-режима — метрики ЭТОЙ инсталляции ──────────────
	"/api/v1/admin/shadow/stats":  true,
	"/api/v1/admin/shadow/drifts": true,

	// already_applied читается из restaurants.shift_balance_corrected_at —
	// таблица restaurants нигде не участвует в sync_log ни в одном направлении
	// (нет ни одного record*Sync/hook/backfill-кейса) — центральный узел может
	// показать «ещё не поправлено» для филиала, где коррекцию давно применили
	// локально. Сами денежные суммы (Lines/TotalCorrection) при этом были бы
	// верны (financial_operations/financial_accounts реплицированы) — но
	// выборочно доверять части ответа нельзя.
	"/api/v1/admin/maintenance/shift-balance-fix": true,

	// ─── Бэкапы — файлы ЭТОЙ машины ─────────────────────────────────────────
	// BackupService.List/Path не принимают context.Context вообще — чистая
	// работа с локальной ФС. Под override покажет бэкапы central, выдавая их
	// за бэкапы филиала — не пустой ответ, а откровенно ЧУЖИЕ данные.
	"/api/v1/backup/list":            true,
	"/api/v1/backup/download/{name}": true,

	// today-stats — orders БЕЗ статус-фильтра для orders_count/revenue
	// (комментарий в коде прямо говорит «открытые/закрытые») — живая
	// операционка, репликация Ф5б её не касается (time_entries — лишь
	// вторая, не единственная причина блокировки).
	"/api/v1/waiters/{id}/today-stats": true,

	// ─── Аудит-лог — вне плана репликации вовсе ─────────────────────────────
	"/api/v1/audit-log": true,

	// ─── Свободные справочники ДДС/бюджет — свои таблицы, вне плана ────────
	"/api/v1/finance/custom-categories": true,
	"/api/v1/budget":                    true,

	// ─── Баланс: активы/обязательства/капитал — те же 3 из 4 блокеров
	// /finance/balance (см. «унаследовано из Ф2-Ф4» ниже), но как отдельные
	// CRUD-страницы, а не только вложенные суммы в одном отчёте. Ни assets,
	// ни liabilities, ни equity_entries нигде не участвуют в sync_log.
	"/api/v1/assets":      true,
	"/api/v1/liabilities": true,
	"/api/v1/equity":      true,

	// ─── Настройки ресторана — правки на филиале никогда не долетают ──────
	// PATCH /api/v1/restaurant пишет в ту же таблицу restaurants, которая не
	// участвует в sync_log ни в одну сторону — central хранит только то, чем
	// ресторан был провижининг, без единого последующего апдейта.
	"/api/v1/restaurant": true,
	// override для /restaurants/{id}/stats формально no-op (Stats() берёт id
	// из URL, не из tenant ctx), но orders_count/last_order_at считаются БЕЗ
	// статус-фильтра — заниженное число и потенциально устаревшая дата.
	"/api/v1/restaurants/{id}/stats": true,

	// ─── Меню — справочники за пределами самой строки menu_items ───────────
	// Базовый /menu/items без query безопасен (только menu_items), но
	// include=tech_cards/ingredient_prices/attributes на ТОМ ЖЕ паттерне
	// джойнят tech_card_lines/semi_finished_stock/menu_attributes*/
	// menu_item_variant_values — ни одна не реплицирована, а middleware не
	// различает query-параметры → блокируем путь целиком.
	"/api/v1/menu/items":                   true,
	"/api/v1/menu/items/{id}/attributes":   true,
	"/api/v1/menu/categories":              true, // отдельная от menu_items таблица, нигде не реплицируется
	"/api/v1/menu/modifier-groups":         true,
	"/api/v1/menu/modifiers":               true,
	"/api/v1/menu/tech-cards":              true, // tech_card_lines
	"/api/v1/semi/types":                   true,
	"/api/v1/semi/types/{id}":              true,
	"/api/v1/semi/stock":                   true, // semi_finished_stock — тот же блокер, что и у /finance/balance
	"/api/v1/size-scales":                  true,
	"/api/v1/menu/items/{id}/max-portions": true, // tech_card_lines + semi_finished_types/stock, плюс живой остаток «прямо сейчас»
	// Резерв считается по orders/order_items WHERE status NOT IN ('closed','cancelled')
	// — ровно нетерминальные, которых на central нет: available = prepared − 0,
	// т.е. ТИХО ЗАВЫШЕННАЯ, а не просто пустая цифра.
	"/api/v1/menu/batch/availability":    true,
	"/api/v1/menu/items/{id}/batch/logs": true, // batch_cooking_logs
	"/api/v1/menu/batch/logs":            true, // batch_cooking_logs

	// ─── CRM/бронирования — свои таблицы, вне плана ────────────────────────
	"/api/v1/customers":                         true,
	"/api/v1/reservations":                      true,
	"/api/v1/reservations/for-table/{table_id}": true, // + окно «ближайшие 12 часов» — по сути живой снимок

	// ─── Конфиг/состояние МАШИНЫ, не филиала ───────────────────────────────
	// Технически override для всех трёх ничего не читает из tenant ctx (Get()
	// не вызывает tenant.RestaurantID вовсе, Info() даже не принимает ctx) —
	// эти данные всегда центрального узла. Блокируем не из соображений
	// безопасности, а чтобы не путать «чья это машина»: иначе выглядит так,
	// будто показан конфиг синхронизации/APK именно филиала X.
	"/api/v1/settings/sync": true,
	"/api/v1/waiter-app":    true,
	"/api/v1/zakup-app":     true,

	// ─── Унаследовано без изменений из Ф2-Ф4 (allowlist-эпоха) ─────────────
	// Причины не пересматривались в Ф7 — форвард-порт старых «НЕ добавлен»
	// записей в новую модель, иначе они молча стали бы default-allowed.
	"/api/v1/finance/pnl":        true, // order_splits (не реплицируется) → revenue.by_method тихо сваливает всю split-выручку в один бакет; headline-суммы верны, но выборочно доверять части ответа нельзя
	"/api/v1/analytics/insights": true, // leakInsights джойнит order_voids (вне плана); lostSalesInsights → StopListService (tech_card_lines)
	"/api/v1/finance/balance":    true, // semi_finished_stock/assets/liabilities/equity_entries — ни одна не реплицирована, считаются из ВСЕХ разом
	"/api/v1/reports/audit.xlsx": true, // audit_log вне плана репликации вовсе
}

// ─── Построчно проверено и подтверждено безопасным (документация, НЕ карта) ─
// Ниже — пути, для которых override реально доезжает до central БЕЗ баннера,
// с кратким «почему». Раньше (allowlist-эпоха, Ф1-Ф6) это были явные записи
// `branchDataAvailable[path] = true`; при инверсии в blocklist они просто
// стали default-allowed — списки оставлены как факт «кто-то реально
// построчно проверил каждый JOIN», а не «никто не запретил». Если нужна
// точная историческая причина по каждому — `git log -p` этого файла до
// v3.16.232 (Ф7) хранит построчные обоснования из Ф1-Ф5.
//
// Ф1 (смены/сотрудники): /network/summary, /finance/cashflow,
//   /finance/monthly-revenue, /shifts[/active], /shifts/{id}[/zreport|/revenue|/operations],
//   /users[/{id}]
// Ф2 (меню/столы): /analytics/abc-menu|peak-hours|waiters|tables|sales-report|trends[.xlsx],
//   /reports/orders.xlsx, /reports/shifts/{id}.xlsx
// Ф3 (склад: остатки): /stock/ingredients[/ingredient-categories|/movements],
//   /analytics/ingredient-stock-value|abc-inventory|food-cost[/monthly]|forecast,
//   /reports/stock-movements.xlsx
// Ф4 (складские документы): /stock/receipts|writeoffs|returns|inventory[/{id}[/lines]],
//   /suppliers, /supply-expenses, /reports/pl.xlsx
// Ф5 (деньги): /finance/accounts[/balance-history], /finance/recurring-payments,
//   /finance/service-{accrual,payout}/by-{waiter,shift/{shift_id}}
//
// Ф7 (доразведано вместе с инверсией — были безопасны и раньше, просто
//   никогда не проверялись построчно; баг был обратный — ложный баннер, не
//   утечка данных):
//   /network/branches, /network/menu, /nomenclature — account-scoped
//     (accountForCtx), override физически не меняет ответ: activates ТОЛЬКО
//     когда curAcc==tgtAcc, а значит account_id инвариантен к подмене.
//   /finance/operations — только своя таблица, курсорная пагинация, без JOIN.
//   /finance/salary/report — financial_operations (category IN Зарплата/
//     Аванс/Сервис) LEFT JOIN users, обе реплицированы; НЕ читает time_entries
//     (в отличие от /finance/salary/accrual|worked-days|deductions — блок выше).
//   /restaurants, /restaurants/{id} — RestaurantsService.List/Get используют
//     Raw() без tenant.RestaurantID(ctx) вовсе (комментарий в коде: «Owner/
//     superadmin only, фильтрации по tenant нет») — override на них не влияет
//     физически, добавлять некуда и незачем.
//   /menu/popularity — orders/order_items с фильтром status IN
//     ('closed','refunded') — ровно терминальные, как и весь остальной orders-код.
//   /zones — models.Zone структурно реплицируется (Ф2), в отличие от /tables
//     не несёт НИ ОДНОГО live-поля (нет status/current_order_id/waiter_id).
//   /stock/transfers[/{id}] — читает только stock_transfers+stock_transfer_lines,
//     реплицируются с ADR-003 Фаза 2/5.1 (пред-плановый фундамент, раньше
//     orders/financial_operations), без JOIN на нереплицированное.
//
// Ф5б (персонал — последняя отложенная под-фаза плана, ГОТОВО):
//   time_entries/salary_worked_days/salary_day_multipliers/salary_deductions/
//   salary_advances реплицированы → сняты /time-entries[/active],
//   /finance/salary/accrual|worked-days|deductions (все читали ровно эти
//   таблицы, см. git blame до Ф5б), /analytics/weekday (ФОТ-колонка читает
//   time_entries JOIN users, обе реплицированы). /finance/salary/advances
//   — читает только salary_advances (теперь реплицирован); ПОПУТНО найден
//   и закрыт живой пробел: этот путь появился ПОСЛЕ Ф7 (миграция 070 через
//   мерж main) и никогда не попадал ни в allow-, ни в blocklist — до этой
//   фазы central молча показывал бы честно выглядящий, но ПУСТОЙ список
//   авансов филиала без единого баннера. /waiters/{id}/today-stats
//   ОСТАЁТСЯ заблокирован — orders там читаются БЕЗ статус-фильтра (живая
//   операционка), Ф5б только сняла одну из двух причин.
//
// Структурно вне досягаемости самого механизма BranchOverride (эффекта от
// добавления/неотсутствия в любую карту нет вовсе — Auth и/или BranchOverride
// не подключены на их роут-группе, см. router.go): /sync/pull, /events (SSE),
// /bootstrap/status, /bootstrap/backups, /public/machine-info, /license/*
// (последний исключён явно и раньше, см. код ниже).

// noTenantSubstitution — пути, для которых override НЕ подменяет tenant в
// контексте вовсе (как и /license/*, см. ниже), а не просто помечается
// баннером «недоступно». Единственный найденный (Explore, 2026-07-31) случай
// GET-хендлера с побочной ЗАПИСЬЮ: WarehouseService.List безусловно вызывает
// ensureWarehouses(rid) — idempotent-по-имени, но НЕ idempotent-по-UUID
// Create() трёх складов при первом обращении для данного rid. Обычная
// подмена tenant означала бы, что central при первом просмотре «как филиал X»
// молча заводит СЕБЕ 3 фантомные строки warehouses с restaurant_id=филиал и
// случайными UUID, никак не связанными с реальными складами филиала (своя
// Postgres, свои UUID) — источник будущего рассинхрона, а не просто неполные
// данные. Баннер «недоступно» при этом всё равно показываем (см. ниже) —
// в отличие от /license/*, здесь это не служебный путь, а раздел, который
// владелец реально пытается посмотреть «за филиал».
var noTenantSubstitution = map[string]bool{
	"/api/v1/warehouses": true,
}

func BranchOverride(db *gorm.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			target := r.Header.Get("X-Branch-Id")
			ctx := r.Context()
			if target == "" || r.Method != http.MethodGet {
				next.ServeHTTP(w, r)
				return
			}
			// Лицензия — свойство ЭТОЙ кассы/машины и никогда не подменяется
			// вьюхой на филиал (см. большой комментарий выше файла): иначе
			// заглушка чужого ресторана без license_expires_at в локальной БД
			// филиала ошибочно уводит кассу на экран активации. Проверяем ДО
			// разбора actor/kind — этот путь исключён безусловно, без баннера
			// (это служебный статус текущей машины, не раздел «данные филиала»).
			if strings.HasPrefix(r.URL.Path, "/api/v1/license/") {
				next.ServeHTTP(w, r)
				return
			}
			actor, _ := audit.ActorFromContext(ctx)
			cur, ok := tenant.RestaurantID(ctx)
			if actor.Role != "owner" || !ok || target == cur {
				next.ServeHTTP(w, r)
				return
			}

			// Текущий ресторан — central_warehouse, и оба ресторана в одной сети?
			type row struct {
				ID        string
				AccountID *string
				Kind      *string
			}
			var rows []row
			wantOverride := false
			if err := db.WithContext(ctx).Model(&models.Restaurant{}).
				Select("id, account_id, kind").
				Where("id IN ?", []string{cur, target}).
				Find(&rows).Error; err == nil {
				var curAcc, tgtAcc, curKind *string
				for _, x := range rows {
					if x.ID == cur {
						curAcc = x.AccountID
						curKind = x.Kind
					}
					if x.ID == target {
						tgtAcc = x.AccountID
					}
				}
				isCentral := curKind != nil && *curKind == "central_warehouse"
				if isCentral && curAcc != nil && *curAcc != "" && tgtAcc != nil && *curAcc == *tgtAcc {
					wantOverride = true
				}
			}
			if wantOverride {
				pattern := chi.RouteContext(ctx).RoutePattern()
				if noTenantSubstitution[pattern] {
					// Не подменяем ctx вовсе (см. комментарий у карты выше) —
					// хендлер физически пишет в БД под rid; баннер всё равно
					// честно показываем, чтобы не выдавать данные central за
					// данные филиала.
					w.Header().Set("X-Branch-Data-Scope", "unavailable")
				} else {
					ctx = tenant.WithRestaurant(ctx, target)
					// Сигнал фронту: просмотр филиала активен, но эти данные
					// сюда ещё не доезжают — фронт покажет баннер вместо того,
					// чтобы тихо отрисовать нули как «у филиала так и есть».
					// См. lib/api/v4-typed.ts.
					if branchDataBlocked[pattern] {
						w.Header().Set("X-Branch-Data-Scope", "unavailable")
					}
				}
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
