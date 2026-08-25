//go:build integration

package service_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestNetworkAnalyticsBatch1 — Пиковые часы / ABC-Меню / ABC-Склад / Продажи
// по всей сети (владелец 2026-08-25: «весь раздел аналитики... сейчас ничего
// нет»). Тот же двух-филиальный фикстур, что и TestNetworkDashboardDetail:
// «Пепперони» продают ОБА филиала под РАЗНЫМИ menu_item_id (своя копия у
// каждого) — главное, что проверяется, это схлопывание блюд по ИМЕНИ, а
// НЕ по id. «Сыр» на складе — наоборот, у ингредиентов нет сетевой
// идентичности, каждая строка ABC-Склад обязана остаться СВОЕЙ, с именем
// филиала, а не слиться с одноимённым товаром на другой точке.
func TestNetworkAnalyticsBatch1(t *testing.T) {
	gdb, err := db.Open(transferTestDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	for _, tbl := range []string{
		"order_items", "orders", "menu_items", "ingredients", "stock_movements",
		"restaurants", "company_accounts", "sync_log",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, b1, b2 := uuid.NewString(), uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: b1, Name: "Филиал-1", AccountID: &accountID, Kind: &ot})
	gdb.Create(&models.Restaurant{ID: b2, Name: "Филиал-2", AccountID: &accountID, Kind: &ot})

	now := time.Now().UTC()
	closed, hall := "closed", "hall"
	cash := "cash"
	pepperoniName, pizzaCat, hot := "Пепперони", "Пиццы", "hot_kitchen"

	// «Пепперони» продают ОБА филиала — с РАЗНЫМИ menu_item_id.
	miB1 := uuid.NewString()
	gdb.Create(&models.MenuItem{ID: miB1, Name: &pepperoniName, Category: &pizzaCat, Station: &hot, RestaurantID: &b1, Price: decimal.MustFromString("46"), UnitSize: decimal.MustFromString("1")})
	miB2 := uuid.NewString()
	gdb.Create(&models.MenuItem{ID: miB2, Name: &pepperoniName, Category: &pizzaCat, Station: &hot, RestaurantID: &b2, Price: decimal.MustFromString("46"), UnitSize: decimal.MustFromString("1")})

	mkOrder := func(rid string) string {
		id := uuid.NewString()
		gdb.Create(&models.Order{
			ID: id, RestaurantID: &rid, Status: &closed, Type: &hall, PaymentMethod: &cash,
			Total: decimal.MustFromString("46"), TotalWithService: decimal.MustFromString("46"), ClosedAt: &now,
			CreatedAt: now, UpdatedAt: now,
		})
		return id
	}
	mkItem := func(orderID, menuItemID, name string) {
		piece := "piece"
		one := decimal.MustFromString("1")
		gdb.Create(&models.OrderItem{
			ID: uuid.NewString(), OrderID: &orderID, MenuItemID: &menuItemID, Name: &name,
			Qty: one, Price: decimal.MustFromString("46"), COGS: decimal.MustFromString("20"),
			Unit: &piece, UnitSize: one,
		})
	}

	o1 := mkOrder(b1)
	mkItem(o1, miB1, pepperoniName)
	o2 := mkOrder(b2)
	mkItem(o2, miB2, pepperoniName)

	// «Сыр» — своя строка на КАЖДОМ филиале, с разной ценой/остатком.
	cheeseB1, cheeseB2 := uuid.NewString(), uuid.NewString()
	kg := "кг"
	gdb.Create(&models.Ingredient{
		ID: cheeseB1, Name: strPtr2("Сыр"), RestaurantID: &b1, Unit: &kg,
		Qty: decimal.MustFromString("10"), MinQty: decimal.MustFromString("2"), PricePerUnit: decimal.MustFromString("100"),
	})
	gdb.Create(&models.Ingredient{
		ID: cheeseB2, Name: strPtr2("Сыр"), RestaurantID: &b2, Unit: &kg,
		Qty: decimal.MustFromString("5"), MinQty: decimal.MustFromString("2"), PricePerUnit: decimal.MustFromString("120"),
	})
	outType := "out"
	gdb.Create(&models.StockMovement{
		ID: uuid.NewString(), IngredientID: &cheeseB1, RestaurantID: &b1, Type: &outType,
		Qty: decimal.MustFromString("-3"), CreatedAt: now,
	})
	gdb.Create(&models.StockMovement{
		ID: uuid.NewString(), IngredientID: &cheeseB2, RestaurantID: &b2, Type: &outType,
		Qty: decimal.MustFromString("-1"), CreatedAt: now,
	})

	svc := service.NewNetworkService(repo.New(gdb), "")
	ctx := tenant.WithRestaurant(context.Background(), centralID)
	from := now.Add(-1 * time.Hour)
	f := service.PeriodFilter{From: &from}

	t.Run("PeakHours", func(t *testing.T) {
		out, err := svc.PeakHours(ctx, f)
		if err != nil {
			t.Fatalf("PeakHours: %v", err)
		}
		if out.TotalOrders != 2 {
			t.Errorf("TotalOrders = %d, want 2 (по одному с каждого филиала)", out.TotalOrders)
		}
		if !out.TotalRevenue.Equal(decimal.MustFromString("92")) {
			t.Errorf("TotalRevenue = %s, want 92", out.TotalRevenue.String())
		}
	})

	t.Run("ABCMenuNetwork", func(t *testing.T) {
		out, err := svc.ABCMenuNetwork(ctx, f)
		if err != nil {
			t.Fatalf("ABCMenuNetwork: %v", err)
		}
		if len(out.Items) != 1 || out.Items[0].Name != pepperoniName {
			t.Fatalf("items: %+v — «Пепперони» с двух филиалов должны схлопнуться по имени", out.Items)
		}
		if !out.Items[0].Revenue.Equal(decimal.MustFromString("92")) {
			t.Errorf("Revenue = %s, want 92 (46+46)", out.Items[0].Revenue.String())
		}
		if !out.Items[0].Qty.Equal(decimal.MustFromString("2")) {
			t.Errorf("Qty = %s, want 2", out.Items[0].Qty.String())
		}
		if out.Items[0].Class != "A" {
			t.Errorf("Class = %s, want A (единственная позиция = 100%% выручки)", out.Items[0].Class)
		}
	})

	t.Run("ABCInventoryNetwork", func(t *testing.T) {
		out, err := svc.ABCInventoryNetwork(ctx, f)
		if err != nil {
			t.Fatalf("ABCInventoryNetwork: %v", err)
		}
		if len(out.Items) != 2 {
			t.Fatalf("items = %d, want 2 (сыр НЕ должен схлопнуться между филиалами)", len(out.Items))
		}
		byBranch := map[string]service.NetworkABCInventoryRow{}
		for _, it := range out.Items {
			byBranch[it.RestaurantName] = it
		}
		b1Row, ok := byBranch["Филиал-1"]
		if !ok {
			t.Fatalf("нет строки «Сыр» для Филиал-1: %+v", out.Items)
		}
		if !b1Row.Consumption.Equal(decimal.MustFromString("3")) {
			t.Errorf("Филиал-1 Consumption = %s, want 3", b1Row.Consumption.String())
		}
		b2Row, ok := byBranch["Филиал-2"]
		if !ok {
			t.Fatalf("нет строки «Сыр» для Филиал-2: %+v", out.Items)
		}
		if !b2Row.Consumption.Equal(decimal.MustFromString("1")) {
			t.Errorf("Филиал-2 Consumption = %s, want 1", b2Row.Consumption.String())
		}
	})

	t.Run("SalesReportNetwork", func(t *testing.T) {
		out, err := svc.SalesReportNetwork(ctx, f)
		if err != nil {
			t.Fatalf("SalesReportNetwork: %v", err)
		}
		if len(out.Rows) != 1 || out.Rows[0].Name != pepperoniName {
			t.Fatalf("rows: %+v — должна остаться одна строка «Пепперони», схлопнутая по имени", out.Rows)
		}
		if !out.Rows[0].Revenue.Equal(decimal.MustFromString("92")) {
			t.Errorf("Revenue = %s, want 92", out.Rows[0].Revenue.String())
		}
		if !out.Totals.Revenue.Equal(decimal.MustFromString("92")) {
			t.Errorf("Totals.Revenue = %s, want 92", out.Totals.Revenue.String())
		}
		if out.Totals.Orders != 2 {
			t.Errorf("Totals.Orders = %d, want 2", out.Totals.Orders)
		}
		if len(out.ByDate) != 1 || out.ByDate[0].Orders != 2 {
			t.Errorf("ByDate: %+v, want 1 день с 2 заказами", out.ByDate)
		}
	})
}
