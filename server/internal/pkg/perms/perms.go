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
		"orders.service_charge": true,
	},
	"cashier": {
		// orders.refund / orders.edit — выключены по умолчанию (чувствительные:
		// возврат и переоткрытие закрытого). Выдаются вручную в матрице доступов.
		"orders.create": true, "orders.close": true, "orders.void": true,
		"orders.reprint": true, "orders.view_others": true,
		"orders.service_charge": true,
		"tables.reserve":        true, "shifts.manage": true, "pos.access": true,
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

// AllPermissions — полный список ключей действий (зеркало ALL_PERMISSIONS,
// lib/types.ts). Нужен для owner/manager (все права = true) в Effective.
var AllPermissions = []string{
	"orders.create", "orders.close", "orders.cancel", "orders.void",
	"orders.refund", "orders.edit", "orders.reprint", "orders.view_others", "orders.create_stopped",
	"orders.service_charge",
	"kitchen.cooking", "tables.edit", "tables.reserve", "shifts.manage", "shifts.history", "pos.access", "showcase.view",
	"inventory.view", "inventory.manage", "suppliers.manage",
	"menu.view", "menu.edit", "menu.view_cost", "writeoffs.create", "batch_cooking.manage",
	"finance.view", "finance.manage", "payroll.manage", "analytics.view",
	"customers.manage", "printers.manage", "users.manage", "audit.view", "data.import",
}

// Effective — эффективная карта прав пользователя (для отдачи клиенту в login,
// чтобы он мог прятать недоступные действия). Зеркалит логику Allow.
func Effective(role string, permissionsJSON []byte) map[string]bool {
	allTrue := func() map[string]bool {
		m := make(map[string]bool, len(AllPermissions))
		for _, k := range AllPermissions {
			m[k] = true
		}
		return m
	}
	if role == "owner" {
		return allTrue()
	}
	// База — дефолты роли (manager: всё true). Персональные права кладём
	// СВЕРХУ как оверрайды, а не заменяя базу целиком. Иначе права,
	// добавленные в AllPermissions ПОСЛЕ сохранения пользователя, молча
	// выключались бы (старый кастом-набор их не содержит) — отсюда «фича
	// недоступна / кнопка пропала» у кастомизированных сотрудников.
	out := make(map[string]bool, len(AllPermissions))
	if role == "manager" {
		out = allTrue()
	} else if d, ok := roleDefaults[role]; ok {
		for k, v := range d {
			out[k] = v
		}
	}
	if len(permissionsJSON) > 0 {
		var p struct {
			Actions map[string]bool `json:"actions"`
		}
		if err := json.Unmarshal(permissionsJSON, &p); err == nil && len(p.Actions) > 0 {
			for k, v := range p.Actions {
				out[k] = v
			}
		}
	}
	return out
}

// Allow — может ли пользователь с ролью role (и опц. персональным permissionsJSON
// формата {"actions": {...}}) выполнить action.
//
// Логика зеркалит фронт (getUserPermissions) и Effective:
//   - owner → всегда да;
//   - если ключ ЕСТЬ в персональных actions — берём его значение (true/false),
//     персональный оверрайд приоритетнее дефолта;
//   - если ключа НЕТ в персональных actions — падаем на дефолт роли. Иначе
//     права, добавленные позже сохранения сотрудника, молча выключались бы.
//   - manager → дефолт «всё да»; прочие роли → roleDefaults.
func Allow(role string, permissionsJSON []byte, action string) bool {
	if role == "owner" {
		return true
	}
	if len(permissionsJSON) > 0 {
		var p struct {
			Actions map[string]bool `json:"actions"`
		}
		if err := json.Unmarshal(permissionsJSON, &p); err == nil && len(p.Actions) > 0 {
			if v, ok := p.Actions[action]; ok {
				return v
			}
			// ключа нет в кастом-наборе → fallthrough на дефолт роли (merge).
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
