package perms

import "testing"

func TestAllow(t *testing.T) {
	cases := []struct {
		name   string
		role   string
		perms  string
		action string
		want   bool
	}{
		// Дефолты ролей (без персональных прав).
		{"waiter не может отменять позиции", "waiter", "", "orders.void", false},
		{"waiter может создавать заказы", "waiter", "", "orders.create", true},
		{"cashier может void", "cashier", "", "orders.void", true},
		{"cashier может refund", "cashier", "", "orders.refund", true},
		{"cashier НЕ может отменять заказ целиком", "cashier", "", "orders.cancel", false},
		{"manager может всё (cancel)", "manager", "", "orders.cancel", true},
		{"owner может всё", "owner", "", "orders.refund", true},
		{"cook не может void", "cook", "", "orders.void", false},
		{"неизвестная роль — запрет", "other", "", "orders.void", false},

		// Персональные права — оверрайды поверх дефолтов роли (merge):
		// присутствующий ключ берёт своё значение, отсутствующий → дефолт роли.
		{"waiter с явным разрешением void", "waiter", `{"actions":{"orders.void":true}}`, "orders.void", true},
		{"cashier с явным запретом void (false)", "cashier", `{"actions":{"orders.void":false}}`, "orders.void", false},
		{"owner игнорирует кастомный запрет", "owner", `{"actions":{"orders.void":false}}`, "orders.void", true},
		// Регрессия: кастом-набор без ключа refund НЕ должен отключать refund —
		// он наследует дефолт роли cashier (иначе «возврат не работает» у
		// кастомизированных кассиров после добавления новых прав).
		{"cashier кастом без refund → дефолт роли", "cashier", `{"actions":{"orders.void":false}}`, "orders.refund", true},
		{"waiter кастом без void-ключа → дефолт (deny)", "waiter", `{"actions":{"orders.create":true}}`, "orders.void", false},
		{"cashier кастом без void-ключа → дефолт (allow)", "cashier", `{"actions":{"orders.create":true}}`, "orders.void", true},

		// Пустой/битый JSON → дефолты роли.
		{"битый json → дефолты", "cashier", `{bad`, "orders.void", true},
		{"пустые actions → дефолты", "waiter", `{"actions":{}}`, "orders.void", false},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := Allow(c.role, []byte(c.perms), c.action)
			if got != c.want {
				t.Fatalf("Allow(%q, %q, %q) = %v, ожидали %v", c.role, c.perms, c.action, got, c.want)
			}
		})
	}
}
