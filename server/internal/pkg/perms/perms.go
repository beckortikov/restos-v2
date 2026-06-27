// Package perms — серверная проверка матрицы доступов (прав ролей/пользователей).
//
// Зеркало фронтового canDo + getUserPermissions + ROLE_DEFAULT_PERMISSIONS
// (lib/types.ts, lib/auth-store.tsx). До этого матрица была ЧИСТО клиентской —
// бэк её не проверял, поэтому официант мог отменять блюда вопреки настройке.
// Теперь enforcement авторитетный: клиент может скрыть кнопку, но даже прямой
// POST упрётся в 403.
package perms

import "encoding/json"

// roleDefaults — actions по умолчанию для роли (зеркало ROLE_DEFAULT_PERMISSIONS).
// owner и manager имеют все права (обрабатываются отдельно в Allow), их тут нет.
var roleDefaults = map[string]map[string]bool{
	"waiter": {
		"orders.create": true, "tables.reserve": true, "menu.view": true, "showcase.view": true,
	},
	"cashier": {
		"orders.create": true, "orders.close": true, "orders.void": true,
		"orders.refund": true, "orders.reprint": true, "orders.view_others": true,
		"tables.reserve": true, "shifts.manage": true, "pos.access": true,
		"showcase.view": true, "customers.manage": true, "printers.manage": true,
	},
	"cook": {
		"kitchen.cooking": true, "menu.view": true, "batch_cooking.manage": true,
	},
	"storekeeper": {
		"inventory.view": true, "inventory.manage": true, "suppliers.manage": true,
		"menu.view": true, "menu.view_cost": true, "writeoffs.create": true,
	},
	"accountant": {
		"finance.view": true, "finance.manage": true, "menu.view_cost": true,
		"analytics.view": true, "audit.view": true,
	},
}

// Allow — может ли пользователь с ролью role (и опц. персональным permissionsJSON
// формата {"actions": {...}}) выполнить action.
//
// Логика зеркалит фронт:
//   - owner → всегда да;
//   - если у пользователя есть персональные actions (хотя бы один ключ) — берём
//     их ЦЕЛИКОМ (отсутствующий ключ = запрет), без слияния с дефолтами;
//   - иначе manager → да, остальные роли → по дефолтам роли.
func Allow(role string, permissionsJSON []byte, action string) bool {
	if role == "owner" {
		return true
	}
	if len(permissionsJSON) > 0 {
		var p struct {
			Actions map[string]bool `json:"actions"`
		}
		if err := json.Unmarshal(permissionsJSON, &p); err == nil && len(p.Actions) > 0 {
			return p.Actions[action]
		}
	}
	if role == "manager" {
		return true
	}
	if d, ok := roleDefaults[role]; ok {
		return d[action]
	}
	return false
}
