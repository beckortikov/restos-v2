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

// TestNetworkDashboardDetail — item-level часть сетевого дашборда (топ блюда/
// категории/оплата/склад/типы/часы), собранная по ЗАКАЗАМ ДВУХ РАЗНЫХ
// ФИЛИАЛОВ. Главное, что проверяется: группировка блюд/категорий идёт по
// ИМЕНИ, а не menu_item_id — у одного и того же сетевого блюда на каждом
// филиале свой локальный id (материализация мастера), и наивный GROUP BY id
// разложил бы одинаковые «Пепперони» с двух филиалов как разные строки.
func TestNetworkDashboardDetail(t *testing.T) {
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
		"order_items", "orders", "menu_items", "ingredients",
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
	closed, hall, delivery := "closed", "hall", "delivery"
	cash, card := "cash", "card"
	pepperoniName, pizzaCat, hot := "Пепперони", "Пиццы", "hot_kitchen"

	// Пепперони продают ОБА филиала — с РАЗНЫМИ menu_item_id (свои копии).
	miB1 := uuid.NewString()
	gdb.Create(&models.MenuItem{ID: miB1, Name: &pepperoniName, Category: &pizzaCat, Station: &hot, RestaurantID: &b1, Price: decimal.MustFromString("46"), UnitSize: decimal.MustFromString("1")})
	miB2 := uuid.NewString()
	gdb.Create(&models.MenuItem{ID: miB2, Name: &pepperoniName, Category: &pizzaCat, Station: &hot, RestaurantID: &b2, Price: decimal.MustFromString("46"), UnitSize: decimal.MustFromString("1")})

	mkOrder := func(rid, typ, pm string, total string) string {
		id := uuid.NewString()
		gdb.Create(&models.Order{
			ID: id, RestaurantID: &rid, Status: &closed, Type: &typ, PaymentMethod: &pm,
			TotalWithService: decimal.MustFromString(total), ClosedAt: &now,
			CreatedAt: now, UpdatedAt: now,
		})
		return id
	}
	mkItem := func(orderID, menuItemID, name string, price string) {
		piece := "piece"
		one := decimal.MustFromString("1")
		gdb.Create(&models.OrderItem{
			ID: uuid.NewString(), OrderID: &orderID, MenuItemID: &menuItemID, Name: &name,
			Qty: one, Price: decimal.MustFromString(price), Unit: &piece, UnitSize: one,
		})
	}

	o1 := mkOrder(b1, hall, cash, "46")
	mkItem(o1, miB1, pepperoniName, "46")
	o2 := mkOrder(b2, delivery, card, "46")
	mkItem(o2, miB2, pepperoniName, "46")

	gdb.Create(&models.Ingredient{
		ID: uuid.NewString(), Name: strPtr2("Сыр"), RestaurantID: &b1,
		Qty: decimal.MustFromString("2"), MinQty: decimal.MustFromString("10"), Unit: strPtr2("кг"),
	})

	svc := service.NewNetworkService(repo.New(gdb), "")
	ctx := tenant.WithRestaurant(context.Background(), centralID)
	from := now.Add(-1 * time.Hour)
	out, err := svc.DashboardDetail(ctx, service.PeriodFilter{From: &from})
	if err != nil {
		t.Fatalf("DashboardDetail: %v", err)
	}

	if len(out.TopDishes) != 1 || out.TopDishes[0].Name != pepperoniName {
		t.Fatalf("топ блюда: %+v — «Пепперони» с двух филиалов должны схлопнуться по имени", out.TopDishes)
	}
	if !out.TopDishes[0].Revenue.Equal(decimal.MustFromString("92")) {
		t.Errorf("выручка «Пепперони» = %s, want 92 (46+46 с двух филиалов)", out.TopDishes[0].Revenue.String())
	}
	if !out.TopDishes[0].Qty.Equal(decimal.MustFromString("2")) {
		t.Errorf("кол-во «Пепперони» = %s, want 2", out.TopDishes[0].Qty.String())
	}

	if len(out.CategorySales) != 1 || out.CategorySales[0].Name != pizzaCat {
		t.Fatalf("категории: %+v", out.CategorySales)
	}
	if !out.CategorySales[0].Revenue.Equal(decimal.MustFromString("92")) {
		t.Errorf("категория «Пиццы» = %s, want 92", out.CategorySales[0].Revenue.String())
	}

	if out.PaymentBreakdown["cash"] != "46" || out.PaymentBreakdown["card"] != "46" {
		t.Errorf("способы оплаты: %+v, want cash=46 card=46", out.PaymentBreakdown)
	}

	typeCounts := map[string]int{}
	for _, r := range out.OrdersByType {
		typeCounts[r.Type] = r.Count
	}
	if typeCounts["hall"] != 1 || typeCounts["delivery"] != 1 {
		t.Errorf("заказы по типам: %+v, want hall=1 delivery=1", typeCounts)
	}

	if len(out.LowStock) != 1 || out.LowStock[0].BranchName != "Филиал-1" || out.LowStock[0].Name != "Сыр" {
		t.Fatalf("низкий остаток: %+v", out.LowStock)
	}

	var hourTotal decimal.Decimal
	for _, h := range out.HourlyRevenue {
		hourTotal = decimal.Add(hourTotal, h.Revenue)
	}
	if !decimal.Normalize(hourTotal).Equal(decimal.MustFromString("92")) {
		t.Errorf("сумма выручки по часам = %s, want 92", hourTotal.String())
	}
}

func strPtr2(s string) *string { return &s }
