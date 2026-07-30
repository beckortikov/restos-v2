package middleware

import (
	"net/http"
	"strings"
)

// CORS — простой middleware для dev-фронта на localhost:3000/5173.
//
// В Electron-продакшене фронт грузится по file:// или http://localhost:3001/...,
// CORS preflight для same-origin не нужен. Но в dev-режиме Vite поднимается на
// :3000, а API — на :3001 — браузер шлёт preflight OPTIONS.
//
// Конфиг через ENV (CSV списком):
//
//	RESTOS_CORS_ALLOWED_ORIGINS=http://localhost:3000,http://localhost:5173
//
// Дефолт: localhost:3000, localhost:5173 (и 127.0.0.1 эквиваленты), плюс
// LAN-доступ официантского APK через * (если ENV пустой).
//
// Заголовки, разрешённые для preflight:
//   - Authorization     (Bearer-токен)
//   - Content-Type      (application/json)
//   - Idempotency-Key   (UUID для write-операций)
//
// Methods: все, что мы используем.
func CORS(allowedOrigins []string) func(http.Handler) http.Handler {
	allowAll := len(allowedOrigins) == 0
	origins := make(map[string]struct{}, len(allowedOrigins))
	for _, o := range allowedOrigins {
		origins[strings.TrimSpace(o)] = struct{}{}
	}

	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			origin := r.Header.Get("Origin")
			if origin != "" {
				// Electron-фронт (file://) шлёт Origin: null или file:// —
				// разрешаем безусловно: это локальная same-machine коммуникация
				// между Electron renderer и sidecar Go-бэком на 127.0.0.1.
				isElectronLocal := origin == "null" || strings.HasPrefix(origin, "file://")
				if allowAll || isElectronLocal {
					w.Header().Set("Access-Control-Allow-Origin", origin)
				} else if _, ok := origins[origin]; ok {
					w.Header().Set("Access-Control-Allow-Origin", origin)
				}
				w.Header().Set("Vary", "Origin")
				w.Header().Set("Access-Control-Allow-Credentials", "true")
				w.Header().Set("Access-Control-Allow-Methods", "GET, POST, PATCH, PUT, DELETE, OPTIONS")
				// X-Skip-Auth-Expire шлёт auth-store на фоновых дозагрузках
				// (ресторан, права): без него в списке разрешённых браузер
				// блокирует САМ запрос после успешного preflight, и настройки
				// ресторана в POS не обновляются вовсе. В Electron и при заходе
				// по LAN на порт бэка это same-origin и CORS не применяется —
				// поэтому промах был виден только на vite-dev (:5173).
				//
				// X-Branch-Id (ADR-003 Фаза 4, «смотреть как филиал») — та же
				// ловушка, найдена вживую на двух параллельных vite-dev (5173+5174):
				// заголовок отправлялся, preflight проходил (204), а САМ запрос
				// браузер молча ронял (net::ERR_FAILED) — сам эндпоинт получал 0
				// байт, фронт видел это как обрыв сети и (до фикса LicenseGate)
				// намертво вис на экране активации.
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Requested-With, X-Skip-Auth-Expire, X-Branch-Id")
				// X-Branch-Data-Scope — ответный заголовок для branchDataScopeMiddleware
				// (баннер «данные филиала недоступны», см. branch_override.go). Без
				// Expose-Headers JS в браузере не может прочитать кастомный
				// response-заголовок кросс-origin — баннер тихо никогда не сработает
				// в dev, только в same-origin проде.
				w.Header().Set("Access-Control-Expose-Headers", "X-Request-Id, X-Branch-Data-Scope")
				w.Header().Set("Access-Control-Max-Age", "600")
			}

			// Preflight — отвечаем сразу.
			if r.Method == http.MethodOptions {
				w.WriteHeader(http.StatusNoContent)
				return
			}

			next.ServeHTTP(w, r)
		})
	}
}
