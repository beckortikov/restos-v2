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

// При ВЫКЛЮЧЕННЫХ техкартах авто-стоп (по остаткам сырья и по готовым порциям
// заготовок) НЕ должен применяться — склад не учитывается, всё продаётся.
// В стопе остаются только ручные override'ы. setupE2E создаёт ресторан с
// tech_cards_enabled=false, поэтому фикстура подходит напрямую.
func TestStopList_TechCardsOff_NoAutoStop(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Заготовка с 0 готовых порций + Гуш 0 на складе (low) + техкарта 100 г.
	seedBatchWithStock(t, gdb, f.rid, "Шашлык", 0, "Гуш", "0", "0")
	var mi models.MenuItem
	if err := gdb.Where("restaurant_id = ? AND name = ?", f.rid, "Шашлык").First(&mi).Error; err != nil {
		t.Fatal(err)
	}

	// 1) Стоп-лист пуст — авто-стоп при выключенных техкартах не работает.
	if names := stopListNames(t, f, tok); len(names) != 0 {
		t.Fatalf("при выключенных техкартах авто-стоп должен быть пуст, получили %v", names)
	}

	// 2) Заказ с этой заготовкой (0 порц., нулевое сырьё) создаётся — не ITEM_STOPPED.
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": mi.ID, "qty": "1"}}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("при выключенных техкартах заказ должен создаваться, получили %d: %s", r.StatusCode, b)
	}

	// 3) Ручной override остаётся в стопе даже при выключенных техкартах.
	manName := "РучнойСтоп"
	yes := true
	if err := gdb.Create(&models.MenuItem{
		ID: uuid.NewString(), Name: &manName, Price: decimal.MustFromString("10"),
		StopListOverride: &yes, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if names := stopListNames(t, f, tok); !hasName(names, "РучнойСтоп") {
		t.Fatalf("ручной override должен оставаться в стопе, получили %v", names)
	}
}
