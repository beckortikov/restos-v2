package middleware

import (
	"net/http"

	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// LicenseRequired — middleware-страж. Если ресторан в locked-состоянии
// (или ручной is_blocked=true) → 403 LICENSE_LOCKED.
//
// Применяется ТОЛЬКО к write-эндпоинтам (POST/PATCH/DELETE). Read-запросы
// и /license/* остаются доступны — Owner должен иметь возможность видеть
// данные и продлевать лицензию даже в locked.
//
// Применять в group ПОСЛЕ Auth-middleware (нужен tenant в context).
func LicenseRequired(svc *service.LicenseService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			rid, ok := tenant.RestaurantID(r.Context())
			if !ok {
				respond.Unauthorized(w, "")
				return
			}
			if svc.IsLocked(r.Context(), rid) {
				respond.JSON(w, http.StatusForbidden, respond.ErrorEnvelope{
					Code:    "LICENSE_LOCKED",
					Message: "restaurant license expired or restaurant blocked; renew via POST /api/v1/license/activate",
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
