package middleware

import (
	"crypto/subtle"
	"net/http"

	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// SyncAuth — межузловой auth для /sync/* (ADR-003 Фаза 3). Филиал и центральный
// узел разделяют общий секрет сети (RESTOS_SYNC_TOKEN): пушер/пуллер шлют его
// как Bearer, центр валидирует. Это machine-to-machine, не user-сессия — у
// филиала нет пользователя на центральном узле.
//
// Если токен на узле не задан — /sync/* закрыт (узел не участвует в sync).
// Сравнение — constant-time (защита от timing-атак на секрет).
func SyncAuth(token string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if token == "" {
				respond.Unauthorized(w, "sync is not enabled on this node")
				return
			}
			got := bearerToken(r.Header.Get("Authorization"))
			if got == "" || subtle.ConstantTimeCompare([]byte(got), []byte(token)) != 1 {
				respond.Unauthorized(w, "invalid sync token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
