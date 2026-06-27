//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"strings"
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

// Новые паки: рост себестоимости (cogs_drift), связки блюд (basket), упущено
// из-за стоп-листа (stop_lost).
func TestInsights_ExtraPacks(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// COGS drift: «Мясо» — две закупки 100 → 150 (+50%).
	ingID, ingName, ingUnit := uuid.NewString(), "Мясо", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("5"), PricePerUnit: decimal.MustFromString("150"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	mkReceipt := func(price string, when time.Time) {
		rcID := uuid.NewString()
		if err := gdb.Create(&models.StockReceipt{ID: rcID, RestaurantID: &f.rid, CreatedAt: when}).Error; err != nil {
			t.Fatal(err)
		}
		if err := gdb.Create(&models.StockReceiptLine{
			ID: uuid.NewString(), ReceiptID: &rcID, IngredientID: &ingID, Name: &ingName,
			Qty: decimal.MustFromString("5"), PricePerUnit: decimal.MustFromString(price), CreatedAt: when,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	mkReceipt("100", time.Date(2025, 6, 10, 12, 0, 0, 0, time.UTC))
	mkReceipt("150", time.Date(2025, 6, 20, 12, 0, 0, 0, time.UTC))

	// Basket + lost-sales: 3 чека с «Пиво»+«Орешки»; «Пиво» вручную в стопе.
	beerID, nutID := uuid.NewString(), uuid.NewString()
	beer, nut, yes := "Пиво", "Орешки", true
	if err := gdb.Create(&models.MenuItem{ID: beerID, Name: &beer, Price: decimal.MustFromString("50"), StopListOverride: &yes, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.MenuItem{ID: nutID, Name: &nut, Price: decimal.MustFromString("30"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	when := time.Date(2025, 6, 15, 12, 0, 0, 0, time.UTC)
	closed := "closed"
	for i := 0; i < 3; i++ {
		oID := uuid.NewString()
		if err := gdb.Create(&models.Order{ID: oID, Status: &closed, ClosedAt: &when, TotalWithService: decimal.MustFromString("80"), RestaurantID: &f.rid}).Error; err != nil {
			t.Fatal(err)
		}
		for _, it := range []struct {
			mid, name, price string
		}{{beerID, beer, "50"}, {nutID, nut, "30"}} {
			mid, nm := it.mid, it.name
			if err := gdb.Create(&models.OrderItem{
				ID: uuid.NewString(), OrderID: &oID, MenuItemID: &mid, Name: &nm,
				Qty: decimal.MustFromString("1"), Price: decimal.MustFromString(it.price),
			}).Error; err != nil {
				t.Fatal(err)
			}
		}
	}

	resp, b := f.get(t, "/api/v1/analytics/insights?from=2025-06-01&to=2025-06-30", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("insights: %d %s", resp.StatusCode, b)
	}
	var rep struct {
		Insights []struct {
			ID string `json:"id"`
		} `json:"insights"`
	}
	if err := json.Unmarshal(b, &rep); err != nil {
		t.Fatal(err)
	}
	has := func(prefix string) bool {
		for _, in := range rep.Insights {
			if strings.HasPrefix(in.ID, prefix) {
				return true
			}
		}
		return false
	}
	for _, want := range []string{"cogs_drift:", "basket:", "stop_lost"} {
		if !has(want) {
			ids := make([]string, 0, len(rep.Insights))
			for _, in := range rep.Insights {
				ids = append(ids, in.ID)
			}
			t.Fatalf("ожидали инсайт с id-префиксом %q, получили %v", want, ids)
		}
	}
}
