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

// TestNetworkAnalyticsBatch1 — Пиковые часы / ABC-Меню / ABC-Склад / Продажи /
// Официанты / Дни недели / Себестоимость по всей сети (владелец 2026-08-25:
// «весь раздел аналитики... сейчас ничего нет»). Тот же двух-филиальный
// фикстур, что и TestNetworkDashboardDetail: «Пепперони» продают ОБА филиала
// под РАЗНЫМИ menu_item_id (своя копия у каждого) — главное, что проверяется,
// это схлопывание блюд по ИМЕНИ, а НЕ по id. «Сыр» на складе — наоборот, у
// ингредиентов нет сетевой идентичности, каждая строка ABC-Склад/Остаток
// обязана остаться СВОЕЙ, с именем филиала, а не слиться с одноимённым
// товаром на другой точке. Официант — та же логика, что склад (свой
// users.id на филиале).
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

	// Официанты: «Иван» — РАЗНЫЕ люди на разных филиалах (совпадение имени
	// не должно схлопывать строки, см. NetworkWaiterRow).
	waiterName, waiterRole := "Иван", "waiter"
	waiterB1, waiterB2 := uuid.NewString(), uuid.NewString()
	gdb.Create(&models.User{ID: waiterB1, Name: &waiterName, Role: &waiterRole, RestaurantID: &b1, HourlyRate: decimal.MustFromString("20000")})
	gdb.Create(&models.User{ID: waiterB2, Name: &waiterName, Role: &waiterRole, RestaurantID: &b2, HourlyRate: decimal.MustFromString("25000")})
	gdb.Exec("UPDATE orders SET waiter_id = ? WHERE id = ?", waiterB1, o1)
	gdb.Exec("UPDATE orders SET waiter_id = ? WHERE id = ?", waiterB2, o2)

	// Табель — для A3 (ФОТ по дням недели) сетевого отчёта.
	gdb.Create(&models.TimeEntry{
		ID: uuid.NewString(), UserID: &waiterB1, RestaurantID: &b1,
		ClockIn: &now, TotalHours: decimal.MustFromString("5"), CreatedAt: now,
	})
	gdb.Create(&models.TimeEntry{
		ID: uuid.NewString(), UserID: &waiterB2, RestaurantID: &b2,
		ClockIn: &now, TotalHours: decimal.MustFromString("3"), CreatedAt: now,
	})

	// Операционный расход — для «Динамики» сетевого отчёта (тот же
	// opex-фильтр, что в ОПиУ/ДДС).
	opType, opCat, opActivity := "out", "other", "operational"
	gdb.Create(&models.FinancialOperation{
		ID: uuid.NewString(), Type: &opType, Category: &opCat, Activity: &opActivity,
		Amount: decimal.MustFromString("10"), RestaurantID: &b1, CreatedAt: now,
	})
	gdb.Create(&models.FinancialOperation{
		ID: uuid.NewString(), Type: &opType, Category: &opCat, Activity: &opActivity,
		Amount: decimal.MustFromString("15"), RestaurantID: &b2, CreatedAt: now,
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

	t.Run("WaitersNetwork", func(t *testing.T) {
		out, err := svc.WaitersNetwork(ctx, f)
		if err != nil {
			t.Fatalf("WaitersNetwork: %v", err)
		}
		if len(out.Rows) != 2 {
			t.Fatalf("rows: %+v — «Иван» с двух филиалов — разные люди, схлопываться не должны", out.Rows)
		}
		byBranch := map[string]service.NetworkWaiterRow{}
		for _, r := range out.Rows {
			byBranch[r.RestaurantName] = r
		}
		b1Row, ok := byBranch["Филиал-1"]
		if !ok {
			t.Fatalf("нет строки официанта для Филиал-1: %+v", out.Rows)
		}
		if b1Row.Name != waiterName || b1Row.Orders != 1 || !b1Row.Revenue.Equal(decimal.MustFromString("46")) {
			t.Errorf("Филиал-1: %+v", b1Row)
		}
		b2Row, ok := byBranch["Филиал-2"]
		if !ok {
			t.Fatalf("нет строки официанта для Филиал-2: %+v", out.Rows)
		}
		if b2Row.Name != waiterName || b2Row.Orders != 1 || !b2Row.Revenue.Equal(decimal.MustFromString("46")) {
			t.Errorf("Филиал-2: %+v", b2Row)
		}
		if out.TotalOrders != 2 || !out.TotalRevenue.Equal(decimal.MustFromString("92")) {
			t.Errorf("totals: orders=%d revenue=%s", out.TotalOrders, out.TotalRevenue.String())
		}
	})

	t.Run("WeekdayNetwork", func(t *testing.T) {
		out, err := svc.WeekdayNetwork(ctx, f)
		if err != nil {
			t.Fatalf("WeekdayNetwork: %v", err)
		}
		// weekday берём из того же `now`, что и фикстур — крошечное окно
		// флаки на границе полуночи по TZ Postgres-сессии, тот же риск, что
		// у PeakHours (там не проявляется — сравниваются только totals).
		wd := int(now.Weekday())
		var row *service.WeekdayRow
		for i := range out.ByWeekday {
			if out.ByWeekday[i].Weekday == wd {
				row = &out.ByWeekday[i]
			}
		}
		if row == nil {
			t.Fatalf("нет строки для weekday=%d: %+v", wd, out.ByWeekday)
		}
		if row.Orders != 2 {
			t.Errorf("Orders = %d, want 2", row.Orders)
		}
		if !row.Revenue.Equal(decimal.MustFromString("92")) {
			t.Errorf("Revenue = %s, want 92", row.Revenue.String())
		}
		if !row.COGS.Equal(decimal.MustFromString("40")) {
			t.Errorf("COGS = %s, want 40 (20+20)", row.COGS.String())
		}
		wantLabor := decimal.MustFromString("175000") // 5×20000 + 3×25000
		if !row.Labor.Equal(wantLabor) {
			t.Errorf("Labor = %s, want %s", row.Labor.String(), wantLabor.String())
		}
		wantGross := decimal.MustFromString("52") // 92-40
		if !row.GrossProfit.Equal(wantGross) {
			t.Errorf("GrossProfit = %s, want %s", row.GrossProfit.String(), wantGross.String())
		}
	})

	t.Run("FoodCostNetwork", func(t *testing.T) {
		out, err := svc.FoodCostNetwork(ctx, f)
		if err != nil {
			t.Fatalf("FoodCostNetwork: %v", err)
		}
		if len(out.Rows) != 1 || out.Rows[0].Name != pepperoniName {
			t.Fatalf("rows: %+v — «Пепперони» с двух филиалов должны схлопнуться по имени", out.Rows)
		}
		if !out.Rows[0].Revenue.Equal(decimal.MustFromString("92")) {
			t.Errorf("Revenue = %s, want 92", out.Rows[0].Revenue.String())
		}
		if !out.Rows[0].COGS.Equal(decimal.MustFromString("40")) {
			t.Errorf("COGS = %s, want 40", out.Rows[0].COGS.String())
		}
		if !out.TotalRevenue.Equal(decimal.MustFromString("92")) || !out.TotalCOGS.Equal(decimal.MustFromString("40")) {
			t.Errorf("totals: revenue=%s cogs=%s", out.TotalRevenue.String(), out.TotalCOGS.String())
		}
	})

	t.Run("FoodCostMonthlyNetwork", func(t *testing.T) {
		out, err := svc.FoodCostMonthlyNetwork(ctx, f)
		if err != nil {
			t.Fatalf("FoodCostMonthlyNetwork: %v", err)
		}
		wantMonth := now.Format("2006-01")
		var m *service.FoodCostMonth
		for i := range out.Months {
			if out.Months[i].Month == wantMonth {
				m = &out.Months[i]
			}
		}
		if m == nil {
			t.Fatalf("нет месяца %s: %+v", wantMonth, out.Months)
		}
		if m.Orders != 2 {
			t.Errorf("Orders = %d, want 2", m.Orders)
		}
		if !m.Revenue.Equal(decimal.MustFromString("92")) {
			t.Errorf("Revenue = %s, want 92", m.Revenue.String())
		}
		if !m.COGS.Equal(decimal.MustFromString("40")) {
			t.Errorf("COGS = %s, want 40", m.COGS.String())
		}
	})

	t.Run("IngredientStockValueNetwork", func(t *testing.T) {
		out, err := svc.IngredientStockValueNetwork(ctx, 10)
		if err != nil {
			t.Fatalf("IngredientStockValueNetwork: %v", err)
		}
		if len(out.Items) != 2 {
			t.Fatalf("items = %d, want 2 (сыр НЕ должен схлопнуться между филиалами)", len(out.Items))
		}
		byBranch := map[string]service.NetworkIngredientStockRow{}
		for _, it := range out.Items {
			byBranch[it.RestaurantName] = it
		}
		// qty на момент чтения — уже ПОСЛЕ денормализации хуком AfterCreate
		// StockMovement (10-3=7, 5-1=4), не сырое значение при вставке.
		b1Row, ok := byBranch["Филиал-1"]
		if !ok {
			t.Fatalf("нет строки «Сыр» для Филиал-1: %+v", out.Items)
		}
		if !b1Row.Value.Equal(decimal.MustFromString("700")) { // 7 × 100
			t.Errorf("Филиал-1 Value = %s, want 700", b1Row.Value.String())
		}
		b2Row, ok := byBranch["Филиал-2"]
		if !ok {
			t.Fatalf("нет строки «Сыр» для Филиал-2: %+v", out.Items)
		}
		if !b2Row.Value.Equal(decimal.MustFromString("480")) { // 4 × 120
			t.Errorf("Филиал-2 Value = %s, want 480", b2Row.Value.String())
		}
		if !out.TotalValue.Equal(decimal.MustFromString("1180")) {
			t.Errorf("TotalValue = %s, want 1180", out.TotalValue.String())
		}
	})

	t.Run("TrendsNetwork", func(t *testing.T) {
		out, err := svc.TrendsNetwork(ctx, f, "day")
		if err != nil {
			t.Fatalf("TrendsNetwork: %v", err)
		}
		if !out.Totals.Revenue.Equal(decimal.MustFromString("92")) {
			t.Errorf("Totals.Revenue = %s, want 92", out.Totals.Revenue.String())
		}
		if out.Totals.OrdersCount != 2 {
			t.Errorf("Totals.OrdersCount = %d, want 2", out.Totals.OrdersCount)
		}
		if !out.Totals.Expenses.Equal(decimal.MustFromString("25")) { // 10+15
			t.Errorf("Totals.Expenses = %s, want 25", out.Totals.Expenses.String())
		}
		if len(out.Buckets) != 1 {
			t.Fatalf("buckets: %+v, want 1 (все заказы/расходы сегодня)", out.Buckets)
		}
	})

	t.Run("ForecastNetwork", func(t *testing.T) {
		out, err := svc.ForecastNetwork(ctx, f)
		if err != nil {
			t.Fatalf("ForecastNetwork: %v", err)
		}
		if out.HistoricalMonths != 1 {
			t.Fatalf("HistoricalMonths = %d, want 1 (фикстур — один месяц)", out.HistoricalMonths)
		}
		if len(out.MonthlyRevenue) != 1 {
			t.Fatalf("MonthlyRevenue: %+v, want 1 месяц — сумма выручки ОБОИХ филиалов", out.MonthlyRevenue)
		}
		m := out.MonthlyRevenue[0]
		if !m.Revenue.Equal(decimal.MustFromString("92")) {
			t.Errorf("Revenue = %s, want 92", m.Revenue.String())
		}
		if !m.COGS.Equal(decimal.MustFromString("40")) {
			t.Errorf("COGS = %s, want 40", m.COGS.String())
		}
		// FixedCostsMonthly — тот же opex 10+15=25 (Trends fixture), один месяц.
		if !out.FixedCostsMonthly.Equal(decimal.MustFromString("25")) {
			t.Errorf("FixedCostsMonthly = %s, want 25", out.FixedCostsMonthly.String())
		}
		if !out.AvgGrossMarginPct.IsPositive() {
			t.Errorf("AvgGrossMarginPct = %s, want positive", out.AvgGrossMarginPct.String())
		}
	})
}
