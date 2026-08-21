package middleware

import (
	"context"
	"crypto/subtle"
	"net/http"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// syncCallerKey — ключ контекста для id филиала, опознанного по его
// персональному токену. Пусто, если пришли с общим (легаси) секретом сети.
type syncCallerKey struct{}

// SyncCallerID — какой филиал аутентифицирован на этом /sync/*-запросе.
// ok=false означает «пришли с общим секретом сети» — узел не опознан.
func SyncCallerID(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(syncCallerKey{}).(string)
	return v, ok && v != ""
}

// SyncAuth — межузловой auth для /sync/* (ADR-003 Фаза 3, ужесточён в Фазе Г).
// Это machine-to-machine, не user-сессия: у филиала нет пользователя на
// центральном узле.
//
// Два принимаемых варианта, в этом порядке:
//
//  1. ПЕРСОНАЛЬНЫЙ токен филиала (Фаза Г) — ищем по SHA-256 в restaurants.
//     Он же даёт центру то, чего у него раньше не было: ИМЯ ЗВОНЯЩЕГО. Отсюда
//     сразу два следствия — отключённый филиал (account_id обнулён при
//     DetachBranch) получает отказ, а не продолжает слать данные в пустоту, и
//     ingest может проверить, что филиал пишет только свои строки.
//
//  2. ОБЩИЙ секрет сети — легаси. Все филиалы, подключённые до Фазы Г, знают
//     только его, и ломать работающие кассы нельзя. Узел при этом не опознан
//     (SyncCallerID вернёт false), поэтому проверки из пункта 1 к нему не
//     применяются. Перестанет работать сам собой, когда все перевыпустят
//     токены; принудительной миграции нет.
//
// Оба сравнения — constant-time (защита от timing-атак на секрет).
func SyncAuth(db *gorm.DB, sharedToken string) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			got := bearerToken(r.Header.Get("Authorization"))
			if got == "" {
				respond.Unauthorized(w, "sync token required")
				return
			}

			// 1. Персональный токен филиала.
			var branch models.Restaurant
			err := db.WithContext(r.Context()).
				Select("id", "account_id", "sync_token_hash").
				Where("sync_token_hash = ?", service.HashSyncToken(got)).
				First(&branch).Error
			if err == nil {
				if branch.AccountID == nil || *branch.AccountID == "" {
					// Филиал отключён от сети (Фаза У). Именно здесь отключение
					// наконец начинает ОТЗЫВАТЬ доступ, а не только прятать
					// точку из отчётов.
					respond.Unauthorized(w, "branch is detached from the network")
					return
				}
				ctx := context.WithValue(r.Context(), syncCallerKey{}, branch.ID)
				next.ServeHTTP(w, r.WithContext(ctx))
				return
			}
			if err != gorm.ErrRecordNotFound {
				respond.Unauthorized(w, "invalid sync token")
				return
			}

			// 2. Общий секрет сети (легаси).
			if sharedToken == "" {
				respond.Unauthorized(w, "sync is not enabled on this node")
				return
			}
			if subtle.ConstantTimeCompare([]byte(got), []byte(sharedToken)) != 1 {
				respond.Unauthorized(w, "invalid sync token")
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}
