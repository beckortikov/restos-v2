// Package repo — базовый репозиторий с обязательной tenant-фильтрацией.
//
// Контракт (CLAUDE.md):
//   - Каждый запрос к БД, который читает/пишет row-данные ресторана,
//     обязан проходить через ForTenant(ctx).
//   - Прямое использование `r.db.Find(...)` без скоупа — ошибка.
//   - Линтер на это запрещение — internal/repo/lint_test.go.
//
// Использование:
//
//	repo := repo.New(db)
//	tx, err := repo.ForTenant(ctx)            // *gorm.DB со скоупом WHERE restaurant_id = ?
//	if err != nil { return err }
//	var orders []models.Order
//	if err := tx.Find(&orders).Error; err != nil { return err }
//
// В транзакции:
//
//	db.Transaction(func(tx *gorm.DB) error {
//	    r := repo.WithTx(tx)
//	    scoped, err := r.ForTenant(ctx); if err != nil { return err }
//	    ...
//	})
package repo

import (
	"context"
	"fmt"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// Repo — корневой репозиторий. Один экземпляр на процесс
// (точнее, на gorm.DB). Безопасен для конкуррентного использования.
type Repo struct {
	db *gorm.DB
}

// New создаёт репозиторий поверх gorm.DB.
func New(db *gorm.DB) *Repo {
	return &Repo{db: db}
}

// WithTx возвращает репозиторий, привязанный к транзакции tx.
// Используется внутри gorm.Transaction-callback'а:
//
//	db.Transaction(func(tx *gorm.DB) error {
//	    r := repo.WithTx(tx)
//	    ...
//	})
func WithTx(tx *gorm.DB) *Repo {
	return &Repo{db: tx}
}

// ForTenant возвращает *gorm.DB, отскоупленный по restaurant_id из контекста.
// Возвращает ErrTenantMissing если в контексте нет restaurant_id.
//
// ВАЖНО: каждый вызов возвращает СВЕЖИЙ Session (NewDB:true). Это обязательно,
// потому что GORM в chain-режиме переиспользует Statement и кэшированную модель
// — если делать `scoped.Create(a); scoped.Create(b)` на одном scoped, второй
// Create панически падает из-за рассинхрона схемы. Поэтому правильный паттерн:
//
//	scoped, _ := r.ForTenant(ctx); scoped.Create(a)
//	scoped, _  = r.ForTenant(ctx); scoped.Create(b)   // ← свежий
//
// Или, если делаешь много операций, вызывай ForTenant перед каждой.
//
// Скоуп применяется как `WHERE restaurant_id = ?`. Если модель не имеет
// колонки restaurant_id (например, order_items, modifiers), скоуп не сработает
// напрямую — для таких моделей нужен JOIN через родительскую таблицу.
// См. ForTenantThroughOrder, ForTenantThroughIngredient и т.д. (добавим по мере надобности).
func (r *Repo) ForTenant(ctx context.Context) (*gorm.DB, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, fmt.Errorf("repo.ForTenant: %w", err)
	}
	return r.db.Session(&gorm.Session{NewDB: true}).
		WithContext(ctx).
		Where("restaurant_id = ?", rid), nil
}

// Raw возвращает «голый» gorm.DB без скоупа.
// Используется ТОЛЬКО для:
//   - login/auth (читаем по PIN/username до того, как знаем restaurant_id);
//   - служебных таблиц без tenant-привязки (idempotency_keys опционально, sync_log в будущем);
//   - миграций.
//
// Любое использование Raw в доменной логике — повод для код-ревью.
func (r *Repo) Raw() *gorm.DB {
	return r.db
}

// DB возвращает корневой gorm.DB (для запуска транзакции).
func (r *Repo) DB() *gorm.DB {
	return r.db
}

// Transaction оборачивает fn в транзакцию. Внутри fn ОБЯЗАТЕЛЬНО использовать
// WithTx, иначе работа пойдёт мимо tx (на корневом DB), а GORM-хуки на audit_log
// окажутся в разных транзакциях.
//
//	err := repo.Transaction(ctx, func(r *repo.Repo) error {
//	    scoped, err := r.ForTenant(ctx); if err != nil { return err }
//	    return scoped.Create(&order).Error
//	})
func (r *Repo) Transaction(ctx context.Context, fn func(*Repo) error) error {
	return r.db.WithContext(ctx).Transaction(func(tx *gorm.DB) error {
		return fn(WithTx(tx))
	})
}
