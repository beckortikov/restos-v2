package middleware

import (
	"net/http"
	"strings"

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
// central (ADR-003 Фаза 2 — financial_operations; Фаза 5.1 — orders/order_items),
// поэтому просмотр через X-Branch-Id для них даёт корректные, а не тихо-нулевые
// цифры. Список сознательно консервативен: аналитика (ABC-меню, продажи и т.п.)
// тоже читает orders/order_items, но местами джойнит ингредиенты/столы/официантов
// (не реплицированы) — не добавляем её сюда, пока это не проверено построчно по
// каждому хендлеру. Пусто здесь = баннер «недоступно» вместо риска показать
// правдоподобную, но неполную цифру.
var branchDataAvailable = map[string]bool{
	"/api/v1/network/summary":         true,
	"/api/v1/finance/cashflow":        true,
	"/api/v1/finance/monthly-revenue": true,
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
			if overridden && !branchDataAvailable[r.URL.Path] {
				w.Header().Set("X-Branch-Data-Scope", "unavailable")
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
