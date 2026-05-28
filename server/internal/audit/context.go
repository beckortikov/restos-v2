// Package audit — централизованная запись мутаций в audit_log через GORM-хуки.
//
// Контракт (CLAUDE.md):
//   - Любая мутация GORM-моделей создаёт запись в audit_log в той же транзакции.
//   - Источник: After{Create,Update,Delete} callbacks, регистрируется в Register(db).
//   - Из контекста запроса берём user_id/user_name (HTTP middleware кладёт ActorFromContext).
//   - Никакого ручного `audit_log.Insert()` в сервисах. Только хук.
//
// Что НЕ логируется:
//   - сам audit_log (чтобы не было петли),
//   - idempotency_keys (cache, не доменные данные),
//   - print_jobs (служебная очередь, имеет собственный лог),
//   - sessions / refresh_tokens (если будут).
package audit

import "context"

// Actor — кто инициировал мутацию. Заполняется HTTP-middleware из сессии.
type Actor struct {
	UserID   string
	UserName string
}

type actorKey struct{}

// WithActor кладёт Actor в контекст.
func WithActor(ctx context.Context, a Actor) context.Context {
	return context.WithValue(ctx, actorKey{}, a)
}

// ActorFromContext извлекает Actor. ok=false если не задан (тогда user_id/name
// пишутся в audit_log как NULL — это допустимо для bootstrap-операций).
func ActorFromContext(ctx context.Context) (Actor, bool) {
	a, ok := ctx.Value(actorKey{}).(Actor)
	return a, ok
}
