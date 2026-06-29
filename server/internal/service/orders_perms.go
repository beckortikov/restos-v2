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
// любого сервиса (orders, столы/зоны и т.д.). owner — всегда разрешён.
func requirePermFor(ctx context.Context, r *repo.Repo, action string) error {
	if hasPermFor(ctx, r, action) {
		return nil
	}
	return apperrors.Wrap("FORBIDDEN", "недостаточно прав для действия: "+action, nil)
}
