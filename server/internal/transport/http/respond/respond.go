// Package respond — единый JSON-ответник: успех, ошибки, потоковый Encoder.
//
// Используется ВСЕМИ хендлерами. Гарантирует, что:
//   - Content-Type выставлен,
//   - доменные ошибки маппятся в ErrorEnvelope (PRD 04),
//   - JSON стримится через Encoder (без промежуточного буфера) — это быстрее
//     на больших списках.
package respond

import (
	"encoding/json"
	"errors"
	"net/http"

	"github.com/rs/zerolog/log"

	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// ErrorEnvelope — стандартный формат ошибок API (PRD 04).
type ErrorEnvelope struct {
	Code    string         `json:"code"`
	Message string         `json:"message"`
	Details map[string]any `json:"details,omitempty"`
}

// JSON стримит body как JSON со статусом code. На ошибке кодирования
// логируем (статус уже отправлен, исправить нельзя).
func JSON(w http.ResponseWriter, status int, body any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	enc := json.NewEncoder(w)
	if err := enc.Encode(body); err != nil {
		log.Error().Err(err).Int("status", status).Msg("respond: encode failed")
	}
}

// Error маппит ошибку в ErrorEnvelope + HTTP-код.
// Маппинг:
//   - apperrors.AppError{Code:...} → ErrorEnvelope с кодом и сообщением
//   - tenant.ErrMissing            → 500 TENANT_MISSING (программная ошибка)
//   - всё остальное                → 500 INTERNAL
func Error(w http.ResponseWriter, err error) {
	var (
		status = http.StatusInternalServerError
		env    = ErrorEnvelope{Code: "INTERNAL", Message: "internal server error"}
	)

	var ae *apperrors.AppError
	switch {
	case errors.As(err, &ae):
		env.Code = ae.Code
		env.Message = ae.Message
		status = statusForCode(ae.Code)
	case errors.Is(err, tenant.ErrMissing):
		env.Code = "TENANT_MISSING"
		env.Message = "restaurant context missing"
		status = http.StatusInternalServerError
	default:
		// Не светим внутреннюю ошибку наружу, но логируем.
		log.Error().Err(err).Msg("respond.Error: unmapped")
	}
	JSON(w, status, env)
}

// statusForCode переводит доменный код ошибки в HTTP-статус.
func statusForCode(code string) int {
	switch code {
	case "NOT_FOUND":
		return http.StatusNotFound
	case "FORBIDDEN":
		return http.StatusForbidden
	case "UNAUTHORIZED":
		return http.StatusUnauthorized
	case "CONFLICT":
		return http.StatusConflict
	case "VALIDATION", "BAD_REQUEST":
		return http.StatusBadRequest
	default:
		return http.StatusInternalServerError
	}
}

// BadRequest — частый случай, шорткат.
func BadRequest(w http.ResponseWriter, message string) {
	JSON(w, http.StatusBadRequest, ErrorEnvelope{Code: "BAD_REQUEST", Message: message})
}

// Unauthorized — шорткат для auth middleware.
func Unauthorized(w http.ResponseWriter, message string) {
	if message == "" {
		message = "authentication required"
	}
	JSON(w, http.StatusUnauthorized, ErrorEnvelope{Code: "UNAUTHORIZED", Message: message})
}

// NotFound — шорткат.
func NotFound(w http.ResponseWriter, message string) {
	if message == "" {
		message = "not found"
	}
	JSON(w, http.StatusNotFound, ErrorEnvelope{Code: "NOT_FOUND", Message: message})
}
