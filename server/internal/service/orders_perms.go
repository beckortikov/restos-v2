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

// requirePermFor — переиспользуемая серверная проверка матрицы доступов для
// любого сервиса (orders, столы/зоны и т.д.). owner — всегда разрешён.
func requirePermFor(ctx context.Context, r *repo.Repo, action string) error {
	actor, _ := audit.ActorFromContext(ctx)
	if actor.Role == "owner" {
		return nil
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	var u models.User
	if err := r.Raw().WithContext(ctx).
		Select("role", "permissions").
		Where("restaurant_id = ? AND id = ?", rid, actor.UserID).
		First(&u).Error; err != nil {
		// Пользователь не найден / ошибка чтения — безопаснее запретить.
		return apperrors.Wrap("FORBIDDEN", "недостаточно прав", nil)
	}
	role := actor.Role
	if u.Role != nil && *u.Role != "" {
		role = *u.Role
	}
	if perms.Allow(role, []byte(u.Permissions), action) {
		return nil
	}
	return apperrors.Wrap("FORBIDDEN", "недостаточно прав для действия: "+action, nil)
}
