package middleware

import (
	"net/http"

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
//   - целевой филиал должен быть в ТОЙ ЖЕ сети (account_id совпадает и не пуст).
//
// При любом несоответствии — тихо игнорируем override (работаем как свой ресторан),
// не отдаём ошибку: заголовок опционален и не должен ломать обычные запросы.
//
// Работает осмысленно на узле, где есть данные филиалов (центральный узел /
// одна общая БД). На отдельной БД филиала чужих данных всё равно нет.
func BranchOverride(db *gorm.DB) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			target := r.Header.Get("X-Branch-Id")
			ctx := r.Context()
			if target == "" || r.Method != http.MethodGet {
				next.ServeHTTP(w, r)
				return
			}
			actor, _ := audit.ActorFromContext(ctx)
			cur, ok := tenant.RestaurantID(ctx)
			if actor.Role != "owner" || !ok || target == cur {
				next.ServeHTTP(w, r)
				return
			}

			// Оба ресторана в одной сети?
			type row struct {
				ID        string
				AccountID *string
			}
			var rows []row
			if err := db.WithContext(ctx).Model(&models.Restaurant{}).
				Select("id, account_id").
				Where("id IN ?", []string{cur, target}).
				Find(&rows).Error; err == nil {
				var curAcc, tgtAcc *string
				for _, x := range rows {
					if x.ID == cur {
						curAcc = x.AccountID
					}
					if x.ID == target {
						tgtAcc = x.AccountID
					}
				}
				if curAcc != nil && *curAcc != "" && tgtAcc != nil && *curAcc == *tgtAcc {
					ctx = tenant.WithRestaurant(ctx, target)
				}
			}
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}
