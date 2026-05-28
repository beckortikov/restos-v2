// Package middleware — HTTP-middleware для restos-server.
package middleware

import (
	"net/http"
	"strings"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// Auth — middleware валидации Bearer-токена.
//
// На success кладёт в контекст:
//   - tenant.WithRestaurant(ctx, sess.RestaurantID)
//   - audit.WithActor(ctx, audit.Actor{UserID, UserName})
//
// На fail → 401.
//
// Применяется к /api/v1/* кроме /api/v1/auth/login.
func Auth(svc *service.AuthService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			tok := bearerToken(r.Header.Get("Authorization"))
			if tok == "" {
				// Fallback: EventSource (SSE) cannot set custom headers, so
				// /api/v1/events accepts ?token=<jwt> as a query-string fallback.
				// We accept it on any route to keep the rule simple; the token is
				// still validated identically.
				tok = strings.TrimSpace(r.URL.Query().Get("token"))
			}
			if tok == "" {
				respond.Unauthorized(w, "Authorization header required")
				return
			}
			cs, err := svc.Validate(r.Context(), tok)
			if err != nil {
				respond.Error(w, err)
				return
			}
			info := cs.Public()

			ctx := tenant.WithRestaurant(r.Context(), info.RestaurantID)
			ctx = audit.WithActor(ctx, audit.Actor{
				UserID:   info.UserID,
				UserName: info.UserName,
			})
			next.ServeHTTP(w, r.WithContext(ctx))
		})
	}
}

func bearerToken(h string) string {
	const prefix = "Bearer "
	if !strings.HasPrefix(h, prefix) {
		return ""
	}
	return strings.TrimSpace(h[len(prefix):])
}

// BearerFromRequest — публичная версия для logout-хендлера и т.п.
// Возвращает пустую строку, если заголовок отсутствует/невалиден.
// Fallback: ?token= query param (для SSE-клиентов, которые не могут
// выставить кастомный header).
func BearerFromRequest(r *http.Request) string {
	if t := bearerToken(r.Header.Get("Authorization")); t != "" {
		return t
	}
	return strings.TrimSpace(r.URL.Query().Get("token"))
}
