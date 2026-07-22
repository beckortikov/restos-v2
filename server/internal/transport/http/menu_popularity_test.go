//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Меню-сорт (060): эндпоинт популярности агрегирует продано штук по позиции за
// окно. Отменённые строки и старые заказы не считаются.
func TestMenuPopularity_AggregatesSoldQty(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	now := time.Now().UTC()
	closed := "closed"
	itemA, itemB := uuid.NewString(), uuid.NewString()

	mkOrder := func(daysAgo int) string {
		oid := uuid.NewString()
		at := now.AddDate(0, 0, -daysAgo)
		if err := gdb.Create(&models.Order{
			ID: oid, OrderNumber: 1000 + daysAgo, Status: &closed, ClosedAt: &at, RestaurantID: &f.rid,
		}).Error; err != nil {
			t.Fatal(err)
		}
		return oid
	}
	mkItem := func(oid, menuID string, qty string, cancelled bool) {
		mid := menuID
		nm := "x"
		it := &models.OrderItem{
			ID: uuid.NewString(), OrderID: &oid, MenuItemID: &mid, Name: &nm,
			Qty: decimal.MustFromString(qty),
		}
		if cancelled {
			c := now
			it.CancelledAt = &c
		}
		if err := gdb.Create(it).Error; err != nil {
			t.Fatal(err)
		}
	}

	// Свежий заказ: A×5, B×2. Ещё один свежий: A×3. Отменённая строка A×99 — не в счёт.
	o1 := mkOrder(2)
	mkItem(o1, itemA, "5", false)
	mkItem(o1, itemB, "2", false)
	mkItem(o1, itemA, "99", true) // cancelled — игнор
	o2 := mkOrder(5)
	mkItem(o2, itemA, "3", false)
	// Старый заказ вне окна (400 дней) — не должен попасть.
	oOld := mkOrder(400)
	mkItem(oOld, itemB, "50", false)

	r, b := f.get(t, "/api/v1/menu/popularity?days=30", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("popularity: %d %s", r.StatusCode, b)
	}
	var resp struct {
		Data []struct {
			MenuItemID string          `json:"menu_item_id"`
			Qty        decimal.Decimal `json:"qty"`
		} `json:"data"`
	}
	_ = json.Unmarshal(b, &resp)
	got := map[string]string{}
	for _, row := range resp.Data {
		got[row.MenuItemID] = row.Qty.String()
	}
	// A = 5 + 3 = 8 (отменённые 99 не в счёт), B = 2 (старые 50 вне окна).
	if got[itemA] != "8" {
		t.Errorf("itemA продано = %q, want 8", got[itemA])
	}
	if got[itemB] != "2" {
		t.Errorf("itemB продано = %q, want 2 (старый заказ вне окна не в счёт)", got[itemB])
	}
}
