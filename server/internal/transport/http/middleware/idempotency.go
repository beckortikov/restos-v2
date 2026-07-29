package middleware

import (
	"bytes"
	"errors"
	"io"
	"net/http"

	"github.com/rs/zerolog/log"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// Idempotency — middleware для write-эндпоинтов.
//
// Поведение:
//   - Нет Idempotency-Key header → 400 (для write обязателен).
//   - Ключ есть, кэш найден, request hash совпал → возвращаем кэш.
//   - Ключ есть, кэш найден, request hash другой → 409 CONFLICT.
//   - Ключа нет в кэше → читаем body, выполняем хендлер с БУФЕРИЗОВАННЫМ writer,
//     сохраняем кэш, потом отдаём ответ клиенту.
//
// ВАЖНО: ответ клиенту отдаётся ТОЛЬКО после Save. Иначе клиент может успеть
// прислать retry до того, как row закоммитился — Lookup промахнётся и хендлер
// выполнится повторно. Эта гонка реальна и она ловилась в e2e-тесте.
//
// Применяется к /api/v1 группам с write-эндпоинтами. На read-эндпоинты не вешать.
func Idempotency(svc *service.IdempotencyService) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			key := r.Header.Get("Idempotency-Key")
			if key == "" {
				respond.BadRequest(w, "Idempotency-Key header is required for write operations")
				return
			}

			body, err := io.ReadAll(r.Body)
			if err != nil {
				respond.BadRequest(w, "failed to read body")
				return
			}
			_ = r.Body.Close()

			ctx := r.Context()

			// #26: РЕЗЕРВИРУЕМ ключ ДО выполнения (INSERT pending-строки). Так ключ
			// занят раньше, чем деньги двинулись. Если процесс упадёт между
			// коммитом операции и записью ответа — останется pending-строка, и
			// повтор получит ErrInProgress (409), а не выполнит операцию второй раз.
			// Раньше ключ писался ПОСЛЕ хендлера — краш в этом окне открывал дорогу
			// двойному списанию.
			var restID *string
			if rid, ok := tenant.RestaurantID(ctx); ok {
				restID = &rid
			}
			var userID *string
			if a, ok := audit.ActorFromContext(ctx); ok && a.UserID != "" {
				userID = &a.UserID
			}
			reserved, cached, err := svc.Reserve(ctx, key, r.Method, r.URL.Path, body, restID, userID)
			if err != nil {
				if errors.Is(err, service.ErrConflict) {
					respond.JSON(w, http.StatusConflict, respond.ErrorEnvelope{
						Code:    "IDEMPOTENCY_CONFLICT",
						Message: "key reused for a different request",
					})
					return
				}
				if errors.Is(err, service.ErrInProgress) {
					respond.JSON(w, http.StatusConflict, respond.ErrorEnvelope{
						Code:    "IDEMPOTENCY_IN_PROGRESS",
						Message: "операция уже выполняется — повторите запрос позже, не дублируйте",
					})
					return
				}
				respond.Error(w, err)
				return
			}
			if cached != nil {
				w.Header().Set("Content-Type", "application/json; charset=utf-8")
				w.Header().Set("X-Idempotent-Replay", "true")
				w.WriteHeader(cached.Status)
				_, _ = w.Write(cached.Body)
				return
			}
			_ = reserved // всегда true здесь (иначе вернулись выше)

			r.Body = io.NopCloser(bytes.NewReader(body))

			// Полностью буферизованный writer. Ничего не уходит клиенту, пока
			// не завершим idempotency-запись.
			bw := newBufferedWriter()
			next.ServeHTTP(bw, r)

			if bw.status >= 200 && bw.status < 300 {
				// Успех — фиксируем ответ в зарезервированной строке.
				if err := svc.Complete(ctx, key, bw.status, bw.body.Bytes()); err != nil {
					log.Error().Err(err).Str("key", key).Msg("idempotency complete failed")
					respond.Error(w, err)
					return
				}
			} else {
				// Не-2xx (валидация/конфликт) — снимаем резерв, чтобы клиент мог
				// исправить запрос и повторить с тем же ключом.
				if err := svc.Release(ctx, key); err != nil {
					log.Error().Err(err).Str("key", key).Msg("idempotency release failed")
				}
			}

			// Теперь flush ответ клиенту.
			for k, vs := range bw.header {
				for _, v := range vs {
					w.Header().Add(k, v)
				}
			}
			w.WriteHeader(bw.status)
			_, _ = w.Write(bw.body.Bytes())
		})
	}
}

// bufferedWriter — собирает ответ полностью в память, без передачи в нижний writer.
type bufferedWriter struct {
	header http.Header
	status int
	body   bytes.Buffer
}

func newBufferedWriter() *bufferedWriter {
	return &bufferedWriter{header: make(http.Header), status: http.StatusOK}
}

func (b *bufferedWriter) Header() http.Header         { return b.header }
func (b *bufferedWriter) WriteHeader(status int)      { b.status = status }
func (b *bufferedWriter) Write(p []byte) (int, error) { return b.body.Write(p) }

// BearerFromRequest re-exported via auth.go.
