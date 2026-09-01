package service

import (
	"context"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/perms"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// requirePerm — авторитетная серверная проверка матрицы доступов. Возвращает
// FORBIDDEN (→403), если у текущего пользователя нет права action.
//
// Раньше матрица была чисто клиентской: бэк её не проверял, поэтому официант
// мог отменять блюда (void) вопреки выключенному праву. Теперь POST упрётся в 403.
func (s *OrdersService) requirePerm(ctx context.Context, action string) error {
	return requirePermFor(ctx, s.r, action)
}

// hasPermFor — bool-проверка права для любого сервиса. owner — всегда true.
func hasPermFor(ctx context.Context, r *repo.Repo, action string) bool {
	actor, _ := audit.ActorFromContext(ctx)
	if actor.Role == "owner" {
		return true
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return false
	}
	var u models.User
	if err := r.Raw().WithContext(ctx).
		Select("role", "permissions").
		Where("restaurant_id = ? AND id = ?", rid, actor.UserID).
		First(&u).Error; err != nil {
		return false // пользователь не найден / ошибка — безопаснее запретить
	}
	role := actor.Role
	if u.Role != nil && *u.Role != "" {
		role = *u.Role
	}
	return perms.Allow(role, []byte(u.Permissions), action)
}

// requirePermFor — переиспользуемая серверная проверка матрицы доступов для
// любого сервиса (orders, склад, столы/зоны и т.д.). owner — всегда разрешён.
func requirePermFor(ctx context.Context, r *repo.Repo, action string) error {
	if hasPermFor(ctx, r, action) {
		return nil
	}
	return apperrors.Wrap("FORBIDDEN", "недостаточно прав для действия: "+action, nil)
}

// actorIDPtr — id человека из контекста, для колонок авторства
// (financial_operations.created_by, миграция 100). nil, когда человека нет:
// репликация с филиала (sync_ingest) и фоновые джобы по расписанию —
// приписывать им «автора» было бы враньём, честнее NULL и «—» в UI.
func actorIDPtr(ctx context.Context) *string {
	actor, ok := audit.ActorFromContext(ctx)
	if !ok || actor.UserID == "" {
		return nil
	}
	id := actor.UserID
	return &id
}

// requireOwner — только владелец (или кросс-тенантный superadmin). Для
// деструктивных админ-операций, которые матрица прав не покрывает отдельным
// action (сброс операций/меню). Роль перечитываем из БД, а не из токена: на
// «стереть всё» полагаться на возможно устаревшую роль в токене нельзя, и
// демоут владельца обязан действовать сразу. Раньше проверки НЕ было вовсе —
// любой аутентифицированный мог стереть ресторан (фронт гейтил owner-only, бэк
// нет).
func requireOwner(ctx context.Context, r *repo.Repo) error {
	actor, _ := audit.ActorFromContext(ctx)
	if actor.Role == "superadmin" {
		return nil
	}
	deny := apperrors.Wrap("FORBIDDEN", "только владелец может выполнить это действие", nil)
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return deny
	}
	var u models.User
	if err := r.Raw().WithContext(ctx).Select("role").
		Where("restaurant_id = ? AND id = ?", rid, actor.UserID).First(&u).Error; err != nil {
		return deny
	}
	if u.Role != nil && (*u.Role == "owner" || *u.Role == "superadmin") {
		return nil
	}
	return deny
}

// ── Порядок блокировок в денежно-складских транзакциях ─────────────────────
//
// Все транзакции, берущие FOR UPDATE больше чем на одну таблицу, ОБЯЗАНЫ брать
// замки в этом порядке:
//
//	stock_returns → suppliers → stock_receipts → financial_accounts → ingredients (id ASC)
//
// Иначе взаимная блокировка. Реальный случай (ревью 17.07.2026): PayDebt брал
// поставщика → счёт → накладные, а CreateReturn — накладную → ингредиенты →
// поставщика → счёт. Классический AB-BA: один держит поставщика и тянется к
// накладной, другой держит накладную и тянется к поставщику. Одновременные
// «оплатить долг» и «возврат» по одному поставщику вешали друг друга, Postgres
// убивал одну транзакцию, кассир получал 500.
//
// Ингредиенты — строго по возрастанию id (ORDER BY id): без сортировки два
// возврата с пересекающимися позициями могут взять их в разном порядке.
//
// Если нужно узнать id поставщика из накладной до её блокировки — читать
// накладную БЕЗ замка (обычный SELECT), затем брать замки по порядку и
// перечитывать накладную уже под замком.
