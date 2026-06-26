package middleware

import (
	"net/http"
	"strings"
	"sync/atomic"

	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// Maintenance — страж на время восстановления БД из бэкапа.
//
// Проблема: pg_restore --clean дропает таблицы, для чего нужен ACCESS EXCLUSIVE
// lock. Пока приложение живо, фронт продолжает опрашивать API → каждое
// соединение держит на таблицах ACCESS SHARE lock → DROP не может взять
// эксклюзив и падает по lock_timeout. Просто оборвать сессии недостаточно:
// фронт мгновенно переподключается.
//
// Поэтому на время restore BackupService взводит флаг, а этот middleware
// возвращает 503 MAINTENANCE на все запросы, КРОМЕ:
//   - /backup/*  — чтобы сам restore (и опрос статуса) прошёл;
//   - /events    — SSE-хаб в памяти, БД не трогает, рвать его незачем;
//   - /healthz, /readyz — вне /api/v1, сюда и так не попадают.
//
// Так на время restore новые запросы не открывают соединений к БД и не держат
// блокировок — DROP проходит мгновенно.
func Maintenance(flag *atomic.Bool) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if flag != nil && flag.Load() && !maintenanceAllowed(r.URL.Path) {
				respond.JSON(w, http.StatusServiceUnavailable, respond.ErrorEnvelope{
					Code:    "MAINTENANCE",
					Message: "идёт восстановление базы из резервной копии, подождите…",
				})
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

// maintenanceAllowed — пути, доступные даже во время restore.
func maintenanceAllowed(path string) bool {
	return strings.Contains(path, "/backup") || strings.Contains(path, "/events")
}
