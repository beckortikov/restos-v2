// Package tenant — носитель restaurant_id в context.Context.
//
// Зачем: в SQLite нет RLS, поэтому tenant-фильтрация — на стороне Go-кода.
// Любой репозиторий обязан использовать ForTenant(ctx) перед запросом к БД,
// иначе один ресторан может прочитать данные другого. См. CLAUDE.md.
//
// Контракт: HTTP middleware кладёт RestaurantID в контекст ДО прокидывания
// запроса в handler. Repos берут его оттуда. Прямой передачи как параметр —
// избегаем, потому что забыть параметр легче, чем забыть про context.
package tenant

import (
	"context"
	"errors"
)

// ErrMissing возвращается, если в контексте не оказалось restaurant_id.
// Это всегда программная ошибка (middleware не отработал) — поднимаем как 500.
var ErrMissing = errors.New("tenant: restaurant_id missing from context")

type ctxKey struct{}

// WithRestaurant кладёт restaurant_id в контекст.
// Вызывается из auth middleware после распаковки сессии/токена.
func WithRestaurant(ctx context.Context, restaurantID string) context.Context {
	return context.WithValue(ctx, ctxKey{}, restaurantID)
}

// RestaurantID извлекает restaurant_id из контекста. ok=false если не задан.
func RestaurantID(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(ctxKey{}).(string)
	if !ok || v == "" {
		return "", false
	}
	return v, true
}

// MustRestaurantID — то же, но возвращает ErrMissing вместо bool.
// Используется в репозиториях, где отсутствие tenant — fatal для запроса.
func MustRestaurantID(ctx context.Context) (string, error) {
	if v, ok := RestaurantID(ctx); ok {
		return v, nil
	}
	return "", ErrMissing
}

// ── Сеть филиалов (account_id), ADR-003 ─────────────────────────────────────
//
// account_id группирует N ресторанов одного владельца. В отличие от
// restaurant_id его может НЕ быть (одиночный ресторан, account_id=NULL) —
// поэтому ForAccount/MustAccountID имеют смысл только для сетевых эндпоинтов.

// ErrAccountMissing — в контексте нет account_id. Либо ресторан не в сети,
// либо middleware не положил account_id. Для сетевых эндпоинтов — это 4xx/500.
var ErrAccountMissing = errors.New("tenant: account_id missing from context")

type accountCtxKey struct{}

// WithAccount кладёт account_id (сеть) в контекст. Вызывается из auth
// middleware, если у ресторана задан account_id.
func WithAccount(ctx context.Context, accountID string) context.Context {
	return context.WithValue(ctx, accountCtxKey{}, accountID)
}

// AccountID извлекает account_id из контекста. ok=false если ресторан не в сети.
func AccountID(ctx context.Context) (string, bool) {
	v, ok := ctx.Value(accountCtxKey{}).(string)
	if !ok || v == "" {
		return "", false
	}
	return v, true
}

// MustAccountID — то же, но возвращает ErrAccountMissing вместо bool.
func MustAccountID(ctx context.Context) (string, error) {
	if v, ok := AccountID(ctx); ok {
		return v, nil
	}
	return "", ErrAccountMissing
}
