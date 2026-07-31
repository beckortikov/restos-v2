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

// branchDataAvailable — пути, чьи данные ПОЛНОСТЬЮ реплицируются с филиала на
// central (ADR-003 Фаза 2 — financial_operations; Фаза 5.1 — orders/order_items;
// «Central видит всё» Ф1 — cash_shifts/cash_shift_operations/users), поэтому
// просмотр через X-Branch-Id для них даёт корректные, а не тихо-нулевые цифры.
// Список сознательно консервативен: аналитика (ABC-меню, продажи и т.п.) тоже
// читает orders/order_items, но местами джойнит ингредиенты/столы/официантов
// (не реплицированы) — не добавляем её сюда, пока это не проверено построчно по
// каждому хендлеру. Пусто здесь = баннер «недоступно» вместо риска показать
// правдоподобную, но неполную цифру.
//
// Ключи — CHI ROUTE PATTERN (chi.RouteContext(ctx).RoutePattern()), НЕ
// r.URL.Path: путь с параметром типа /shifts/{id} в реальном запросе всегда
// содержит подставленный UUID, а не литерал "{id}" — сверка по r.URL.Path
// никогда бы не совпала (баг, найден при добавлении первых параметризованных
// путей в Ф1). RoutePattern() уже разрешён на этот момент (проверено —
// middleware выполняется ПОСЛЕ того, как chi нашёл маршрут) и включает полный
// префикс /api/v1.
var branchDataAvailable = map[string]bool{
	"/api/v1/network/summary":         true,
	"/api/v1/finance/cashflow":        true,
	"/api/v1/finance/monthly-revenue": true,
	// Ф1 (смены + сотрудники) — cash_shifts/cash_shift_operations реплицируются
	// на каждое сохранение (см. recordShiftSync), ZReport построчно проверен:
	// зависит только от cash_shifts/cash_shift_operations (свои) + orders/
	// order_items/financial_operations (уже реплицированы Фаза 2/5.1) + users
	// (Ф1, имена официантов/кассира) — menu_items/financial_accounts JOIN'ятся
	// с graceful COALESCE-фолбэком (деградируют до Ф2/Ф5, не ломаются).
	"/api/v1/shifts":                 true,
	"/api/v1/shifts/active":          true,
	"/api/v1/shifts/{id}":            true,
	"/api/v1/shifts/{id}/zreport":    true,
	"/api/v1/shifts/{id}/revenue":    true,
	"/api/v1/shifts/{id}/operations": true,
	// users — сам по себе не джойнит ничего нереплицированного (имена
	// официантов/кассиров для смен, фильтр «по сотруднику»).
	"/api/v1/users":      true,
	"/api/v1/users/{id}": true,

	// Ф2 (меню + столы/зоны) — menu_items снапшот на каждое сохранение
	// (см. recordMenuItemsSync), tables/zones structural CRUD (см.
	// recordTableSync/recordZoneSync). Построчно проверены (Explore, 2026-07-30)
	// все analytics/*-хендлеры и reports/*.xlsx — ниже добавлены ТОЛЬКО те, что
	// читают исключительно orders/order_items/financial_operations/cash_shifts/
	// cash_shift_operations/users/menu_items/tables/zones (все уже реплицированы).
	// НЕ добавлены на момент Ф2 (зависят от НЕреплицированного, дают
	// тихо-неверную цифру, не просто баннер): /finance/pnl и /reports/pl.xlsx
	// (stock_writeoffs, /reports/pl.xlsx ещё и supply_expenses — обе таблицы
	// реплицированы Ф4: /reports/pl.xlsx переехал в разрешённые ниже,
	// /finance/pnl остался запрещён по ДРУГОЙ причине — см. Ф4), /reports/audit.xlsx
	// (audit_log — вне плана репликации вовсе), /analytics/weekday
	// (time_entries — Ф5б «Персонал», ФОТ прямо входит в NetProfit).
	"/api/v1/analytics/abc-menu":       true,
	"/api/v1/analytics/peak-hours":     true,
	"/api/v1/analytics/waiters":        true,
	"/api/v1/analytics/tables":         true,
	"/api/v1/analytics/sales-report":   true,
	"/api/v1/analytics/trends":         true,
	"/api/v1/analytics/trends.xlsx":    true,
	"/api/v1/reports/orders.xlsx":      true,
	"/api/v1/reports/shifts/{id}.xlsx": true,

	// Ф3 (склад: остатки + движения) — ingredients снапшот (денормализованный
	// qty, синкается и явными точками, и внутри самого хука денормализации,
	// см. sync_stock.go/audit/stock_hook.go), stock_movements append-only
	// (generic trackedInsert). Построчно проверены (Explore, 2026-07-30):
	// /analytics/food-cost*, /forecast — ошибочно считались «складскими» по
	// названию в комментарии Ф2 выше; реально читают только orders/order_items
	// (cogs заморожен на филиале в момент продажи, см. orders_write.go) и
	// financial_operations (forecast, fixed costs) — были безопасны уже с Ф1,
	// просто не проверены построчно тогда. /reports/stock-movements.xlsx —
	// читает только stock_movements, был в «не добавлено» списке Ф2 как раз
	// потому что stock_movements ещё не реплицировался — теперь можно.
	//
	// НЕ добавлен /analytics/insights на момент Ф3: агрегатор из 7 паков, один
	// из которых (cogsDriftInsights) JOIN'ит stock_receipts/stock_receipt_lines
	// (Ф4, складские документы — тогда ещё не реплицированы). Эта причина Ф4
	// СНЯТА (см. ниже), но нашлись ДВЕ ДРУГИЕ, независимые — путь остаётся
	// запрещён.
	"/api/v1/stock/ingredients":                true,
	"/api/v1/stock/ingredient-categories":      true,
	"/api/v1/stock/movements":                  true,
	"/api/v1/analytics/ingredient-stock-value": true,
	"/api/v1/analytics/abc-inventory":          true,
	"/api/v1/analytics/food-cost":              true,
	"/api/v1/analytics/food-cost/monthly":      true,
	"/api/v1/analytics/forecast":               true,
	"/api/v1/reports/stock-movements.xlsx":     true,

	// Ф4 (складские документы: приёмки/списания/инвентаризации/возвраты/
	// поставщики/снабжение) — снапшот-по-id для 4 документов с дочерними
	// строками (stock_receipts/stock_writeoffs/inventory_checks/stock_returns,
	// см. recordReceiptSync/recordWriteoffSync/recordInventorySync/
	// recordReturnSync в sync_docs.go), плоский снапшот+delete для suppliers,
	// generic trackedInsert для supply_expenses (append-only, единственная
	// точка создания никогда не мутирует строку). Построчно проверены
	// (Explore, 2026-07-31), ни один JOIN на нереплицированное:
	"/api/v1/stock/receipts":             true,
	"/api/v1/stock/writeoffs":            true,
	"/api/v1/stock/returns":              true,
	"/api/v1/stock/inventory":            true,
	"/api/v1/stock/inventory/{id}":       true,
	"/api/v1/stock/inventory/{id}/lines": true,
	"/api/v1/suppliers":                  true,
	"/api/v1/supply-expenses":            true,
	// /reports/pl.xlsx — computePnL (reports_pl.go) читает РОВНО 4 таблицы:
	// orders/order_items (Ф2/5.1), stock_writeoffs/supply_expenses (Ф4) —
	// подтверждено построчным чтением функции, не только Explore. Отличается
	// от /finance/pnl (см. ниже) — это ДРУГАЯ, более простая реализация без
	// разбивки revenue.by_method.
	"/api/v1/reports/pl.xlsx": true,

	// НЕ добавлен /finance/pnl (в отличие от /reports/pl.xlsx выше!): читает
	// те же 4 реплицированные таблицы для headline-цифр (revenue/cogs/
	// writeoffs/opex/profit — они были бы верны), НО ещё и order_splits для
	// revenue.by_method (finance.go) — эта таблица НЕ реплицируется. На
	// central для заказов с payment_method='split' order_splits пуст →
	// код уходит в свой же fallback (изначально рассчитанный на редкий
	// edge-case гонки на филиале, не на систематическое отсутствие данных) и
	// сваливает ВСЮ split-выручку в один бакет "split" вместо разбивки по
	// факту (наличные/карта) — тихо неверная часть ответа, не просто баннер.
	// Итоговые суммы (net_profit и т.п.) при этом верны — деградирует только
	// одно вложенное поле, но выборочно возвращать часть ответа нельзя (тот
	// же принцип, что и у /analytics/insights).
	//
	// НЕ добавлен /analytics/insights: причина Ф3 (cogsDriftInsights →
	// stock_receipts) снята репликацией Ф4, но построчная проверка ВСЕХ 7
	// паков агрегатора нашла две другие, ранее не всплывавшие: leakInsights
	// JOIN'ит order_voids (не реплицируется вовсе, вне плана), lostSalesInsights
	// делегирует в StopListService.List, который для авто-стопа по нехватке
	// сырья читает tech_card_lines (тоже не реплицируется) — на central даст
	// пустой список авто-стопов вместо заниженного/пустого impact в ₽, не
	// текстовую деталь. Остальные 5 паков сами по себе безопасны, но выборочно
	// допускать часть ответа агрегатора нельзя (тот же принцип, что у Ф3).
	//
	// НЕ добавлен /finance/balance на момент Ф4: помимо suppliers.current_debt
	// (теперь реплицирован) читал financial_accounts/semi_finished_stock/
	// assets/liabilities/equity_entries — ни одна тогда не была реплицирована.
	// financial_accounts реплицирован Ф5 (см. ниже) — эта причина снята, но
	// остаются 4 самостоятельных блокера (semi_finished_stock/assets/
	// liabilities/equity_entries, всё ещё вне плана репликации) — вердикт не
	// меняется, см. актуальное обоснование в конце Ф5 ниже.

	// Ф5 (деньги: счета + платежи) — financial_accounts: первая и единственная
	// сущность плана на generic AfterCreate+AfterUpdate хук (trackedSave,
	// synclog/recorder_hook.go) — точек мутации баланса ~20 по всему
	// кодовому базу, явные recordXSync на каждой были бы избыточны. Хук
	// перечитывает строку из БД по id ПОСЛЕ апдейта (не полагается на
	// значение из Updates(map)/gorm.Expr, что было бы ненадёжно — 6 из 20
	// точек пишут баланс именно через gorm.Expr). recurring_payments —
	// explicit (4 точки: Create/Patch/Delete/Pay), как в Ф1-Ф4. Закрыт
	// delete-пробел financial_operations (DeleteExpense/DeleteOperation
	// реально удаляют связанную финоперацию — generic trackedInsert-хук
	// ловит только insert). Построчно проверены (Explore, 2026-07-31):
	"/api/v1/finance/accounts":                            true,
	"/api/v1/finance/accounts/balance-history":            true,
	"/api/v1/finance/recurring-payments":                  true,
	"/api/v1/finance/service-accrual/by-waiter":           true,
	"/api/v1/finance/service-accrual/by-shift/{shift_id}": true,
	"/api/v1/finance/service-payout/by-waiter":            true,
	"/api/v1/finance/service-payout/by-shift/{shift_id}":  true,
	// service-accrual/service-payout читают только orders (o.service_amount,
	// замороженный при закрытии заказа)/financial_operations/users — уже
	// реплицированы (Ф1/Ф2/5.1). Разблокирует часть баннера на «Смены»
	// (Ф1-эра комментарий выше: «также читает finance/accounts +
	// finance/service-accrual|payout» — обе причины теперь сняты; остаётся
	// только Ф5б «Персонал»/time_entries, если она вообще нужна этой странице).
	//
	// НЕ добавлен /finance/balance (см. выше, актуальные 4 блокера):
	// semi_finished_stock, assets, liabilities, equity_entries — ни одна не
	// реплицирована, а GrandTotalAssets/GrandTotalLiabilities/ComputedEquity
	// считаются из ВСЕХ сразу (finance.go) — частичная деградация невозможна.
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
			// разбора actor/kind — этот путь исключён безусловно.
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
			overridden := false
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
					ctx = tenant.WithRestaurant(ctx, target)
					overridden = true
				}
			}
			// Сигнал фронту: просмотр филиала активен, но эти данные сюда ещё не
			// доезжают — фронт покажет баннер вместо того, чтобы тихо отрисовать
			// нули как «у филиала так и есть». См. lib/api/v4-typed.ts.
			pattern := chi.RouteContext(ctx).RoutePattern()
			if overridden && !branchDataAvailable[pattern] {
				w.Header().Set("X-Branch-Data-Scope", "unavailable")
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
