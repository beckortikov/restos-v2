//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// «Инсайты»: кросс-аналитика выдаёт ранжированные действия. Сеем данные, которые
// триггерят паки menu (маржинальная дыра), leak (скидки/возвраты/отмены) и
// stock (неликвид), и проверяем, что соответствующие категории появились.
func TestInsights_CrossAnalytics(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	now := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC)
	closed := "closed"
	// Закрытый чек со скидкой 100 и возвратом 50 (выручка 200).
	ordID := uuid.NewString()
	if err := gdb.Create(&models.Order{
		ID: ordID, Status: &closed, ClosedAt: &now, RestaurantID: &f.rid,
		TotalWithService: decimal.MustFromString("200"),
		DiscountAmount:   decimal.MustFromString("100"),
		RefundedTotal:    decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	// Два блюда: A маржа 10% (дыра), B маржа 90% → медиана 50%.
	mkItem := func(name, price, cogs string) {
		miID, n := uuid.NewString(), name
		if err := gdb.Create(&models.MenuItem{ID: miID, Name: &n, Price: decimal.MustFromString(price), RestaurantID: &f.rid}).Error; err != nil {
			t.Fatal(err)
		}
		if err := gdb.Create(&models.OrderItem{
			ID: uuid.NewString(), OrderID: &ordID, MenuItemID: &miID, Name: &n,
			Qty: decimal.MustFromString("1"), Price: decimal.MustFromString(price), COGS: decimal.MustFromString(cogs),
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	mkItem("Бургер", "100", "90") // маржа 10%
	mkItem("Чай", "100", "10")    // маржа 90%

	// Отмена позиции (void) на 60.
	voidName := "Вася"
	itemName := "Стейк"
	q2 := 2
	if err := gdb.Create(&models.OrderVoid{
		ID: uuid.NewString(), OrderID: &ordID, ItemName: &itemName, ItemQty: &q2,
		ItemPrice: decimal.MustFromString("30"), CreatedByName: &voidName,
		RestaurantID: &f.rid, CreatedAt: now,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Неликвид: ингредиент на 500 без движений.
	ingName, ingUnit := "Залежь", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: uuid.NewString(), Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("10"), PricePerUnit: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	resp, b := f.get(t, "/api/v1/analytics/insights?from=2025-06-01&to=2025-06-30", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("insights: %d %s", resp.StatusCode, b)
	}
	var rep struct {
		Insights []struct {
			Category string          `json:"category"`
			ID       string          `json:"id"`
			Impact   decimal.Decimal `json:"impact"`
		} `json:"insights"`
	}
	if err := json.Unmarshal(b, &rep); err != nil {
		t.Fatal(err)
	}
	cats := map[string]bool{}
	for _, in := range rep.Insights {
		cats[in.Category] = true
	}
	for _, want := range []string{"menu", "leak", "stock"} {
		if !cats[want] {
			t.Fatalf("ожидали инсайт категории %q, получили категории %v (всего %d)", want, cats, len(rep.Insights))
		}
	}
}
