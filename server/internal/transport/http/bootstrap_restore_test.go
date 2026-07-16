//go:build integration

package http_test

import (
	"testing"

	"github.com/restos/restos-v4/server/internal/db"
)

// Публичное восстановление из бэкапа (GET /bootstrap/backups, POST
// /bootstrap/restore[/{name}]) разрешено ТОЛЬКО пока база не инициализирована
// (нет ресторана). Как только ресторан есть — 409, восстановление только после
// логина. Это защита от анонимной перезаписи чужой базы по LAN.
func TestBootstrapRestore_GuardByInitialized(t *testing.T) {
	f := setupE2E(t) // фикстура создаёт ресторан → система инициализирована

	// 1) Инициализирована → 409 на всех публичных restore-маршрутах.
	for _, path := range []string{"/api/v1/bootstrap/backups"} {
		resp, _ := f.get(t, path, "")
		if resp.StatusCode != 409 {
			t.Errorf("initialized: GET %s want 409, got %d", path, resp.StatusCode)
		}
	}
	if resp, _ := f.post(t, "/api/v1/bootstrap/restore/whatever.dump", "", "", nil); resp.StatusCode != 409 {
		t.Errorf("initialized: POST restore/{name} want 409, got %d", resp.StatusCode)
	}

	// 2) Убираем ресторан (и его пользователей) → система НЕ инициализирована →
	//    гейт пропускает (409 быть не должно; дальше уже логика backup-сервиса).
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	gdb.Exec("DELETE FROM users WHERE restaurant_id = ?", f.rid)
	gdb.Exec("DELETE FROM restaurants WHERE id = ?", f.rid)

	resp, _ := f.get(t, "/api/v1/bootstrap/backups", "")
	if resp.StatusCode == 409 {
		t.Errorf("uninitialized: GET /bootstrap/backups не должен быть 409")
	}
}
