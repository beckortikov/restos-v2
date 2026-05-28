// Package errors — типизированные ошибки доменного слоя.
//
// Используются в репозиториях и сервисах. HTTP-слой маппит их в ErrorEnvelope
// (см. docs/prd/04-API-CONTRACT.md).
package errors

import "errors"

// Стандартные wrap-функции.
var (
	Is     = errors.Is
	As     = errors.As
	Unwrap = errors.Unwrap
	New    = errors.New
)

// AppError — структурированная ошибка с кодом, понятным HTTP-слою.
type AppError struct {
	Code    string // стабильный машинно-читаемый код (см. PRD 04)
	Message string // human-readable
	Cause   error  // оригинальная ошибка (опционально)
}

func (e *AppError) Error() string {
	if e.Cause != nil {
		return e.Message + ": " + e.Cause.Error()
	}
	return e.Message
}

func (e *AppError) Unwrap() error { return e.Cause }

// Канонические ошибки.
var (
	ErrNotFound      = &AppError{Code: "NOT_FOUND", Message: "resource not found"}
	ErrTenantMissing = &AppError{Code: "TENANT_MISSING", Message: "restaurant_id missing from context"}
	ErrForbidden     = &AppError{Code: "FORBIDDEN", Message: "operation not permitted"}
	ErrConflict      = &AppError{Code: "CONFLICT", Message: "resource conflict"}
	ErrValidation    = &AppError{Code: "VALIDATION", Message: "validation failed"}
)

// Wrap — обёртывание stdlib-ошибки в AppError с кодом.
func Wrap(code, message string, cause error) *AppError {
	return &AppError{Code: code, Message: message, Cause: cause}
}
