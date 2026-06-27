//go:build integration

package http_test

import (
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Частичное использование склада: техкарты ВКЛ, но проверка остатков ВЫКЛ
// (enforce_stock_check=false). Тогда позиция БЕЗ техкарты продаётся свободно
// (без списания), а при ВКЛ enforce — блокируется («нет техкарты»). Это даёт
// владельцу режим «склад только для напитков и части блюд».
func TestOrder_PartialStock_NoTechCard(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	enableTechCards(t, gdb, f.rid) // техкарты ON; enforce_stock_check остаётся OFF

	drinkName := "Кола"
	drinkID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: drinkID, Name: &drinkName, Price: decimal.MustFromString("15"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	order := map[string]any{"items": []map[string]any{{"menu_item_id": drinkID, "qty": "1"}}}

	// 1) enforce OFF (lenient): позиция без техкарты ПРОДАЁТСЯ.
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), order)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("enforce OFF: позиция без техкарты должна продаваться, получили %d: %s", r.StatusCode, b)
	}

	// 2) enforce ON (strict): та же позиция БЛОКИРУЕТСЯ («нет техкарты»).
	if err := gdb.Exec(`UPDATE restaurants SET enforce_stock_check = true WHERE id = ?`, f.rid).Error; err != nil {
		t.Fatal(err)
	}
	r2, b2 := f.post(t, "/api/v1/orders", tok, uuid.NewString(), order)
	if r2.StatusCode == http.StatusCreated {
		t.Fatalf("enforce ON: позиция без техкарты должна блокироваться, но заказ создан: %s", b2)
	}
}
