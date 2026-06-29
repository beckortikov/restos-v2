//go:build integration

package http_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
)

// Право tables.edit («Редактирование столов и зон») должно реально блокировать
// создание/правку зон и столов на бэке, а не только прятать кнопку.
func TestTables_EditPermissionEnforced(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Снимаем у кассира tables.edit (галочка выключена в матрице).
	if err := gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"orders.create":true}}`))).Error; err != nil {
		t.Fatal(err)
	}

	// Создание зоны → 403.
	if r, b := f.post(t, "/api/v1/zones", tok, uuid.NewString(), map[string]any{"name": "Зал"}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("без tables.edit создание зоны должно быть 403, получили %d: %s", r.StatusCode, b)
	}
	// Создание стола → 403.
	if r, b := f.post(t, "/api/v1/tables", tok, uuid.NewString(), map[string]any{"name": "Стол 1", "seats": 4}); r.StatusCode != http.StatusForbidden {
		t.Fatalf("без tables.edit создание стола должно быть 403, получили %d: %s", r.StatusCode, b)
	}

	// Возвращаем право → создание зоны проходит.
	if err := gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"orders.create":true,"tables.edit":true}}`))).Error; err != nil {
		t.Fatal(err)
	}
	if r, b := f.post(t, "/api/v1/zones", tok, uuid.NewString(), map[string]any{"name": "Зал"}); r.StatusCode != http.StatusCreated {
		t.Fatalf("с tables.edit создание зоны должно проходить, получили %d: %s", r.StatusCode, b)
	}
}
