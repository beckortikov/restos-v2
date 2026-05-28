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
				w.Header().Set("Access-Control-Allow-Headers", "Authorization, Content-Type, Idempotency-Key, X-Requested-With")
				w.Header().Set("Access-Control-Expose-Headers", "X-Request-Id")
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
