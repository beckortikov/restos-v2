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
