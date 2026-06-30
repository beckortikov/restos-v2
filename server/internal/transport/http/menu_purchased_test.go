//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Логика «покупного товара» в бэке: создание/редактирование покупного блюда
// само заводит складской ингредиент (0 остаток) + 1:1 техкарту + station=showcase,
// и сохраняет флаг is_purchased.
func TestMenu_PurchasedBackend_Create(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	r, b := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(), map[string]any{
		"name": "Кола", "category": "Напитки", "price": "15",
		"is_purchased": true, "purchase_price": "10", "purchase_unit": "шт", "purchase_min_qty": "5",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create purchased: %d %s", r.StatusCode, b)
	}
	var created struct {
		ID          string `json:"id"`
		IsPurchased bool   `json:"is_purchased"`
		Station     string `json:"station"`
	}
	if err := json.Unmarshal(b, &created); err != nil {
		t.Fatal(err)
	}
	if !created.IsPurchased || created.Station != "showcase" {
		t.Fatalf("ожидали is_purchased=true station=showcase, получили %+v", created)
	}

	// Техкарта 1:1 + backing-ингредиент с 0 остатком и ценой 10.
	var lines []models.TechCardLine
	if err := gdb.Where("menu_item_id = ?", created.ID).Find(&lines).Error; err != nil {
		t.Fatal(err)
	}
	if len(lines) != 1 || lines[0].IngredientID == nil || !lines[0].Qty.Equal(decimal.MustFromString("1")) {
		t.Fatalf("ожидали 1 техкарту 1:1, получили %+v", lines)
	}
	var ing models.Ingredient
	if err := gdb.Where("id = ?", *lines[0].IngredientID).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.Qty.Equal(decimal.Zero) || !ing.PricePerUnit.Equal(decimal.MustFromString("10")) ||
		!ing.MinQty.Equal(decimal.MustFromString("5")) || ing.Unit == nil || *ing.Unit != "шт" {
		t.Fatalf("backing-ингредиент неверен: qty=%s price=%s min=%s unit=%v",
			decimal.Normalize(ing.Qty), decimal.Normalize(ing.PricePerUnit), decimal.Normalize(ing.MinQty), ing.Unit)
	}
}

// PATCH обычного блюда → покупное: создаётся НОВЫЙ ингредиент (общий ингредиент
// рецепта не трогаем), флаг и техкарта обновляются.
func TestMenu_PurchasedBackend_PatchConvert(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Обычное блюдо.
	name := "Чай"
	miID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{ID: miID, Name: &name, Price: decimal.MustFromString("20"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.patch(t, "/api/v1/menu/items/"+miID, tok, uuid.NewString(), map[string]any{
		"is_purchased": true, "purchase_price": "8", "purchase_unit": "шт",
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("patch purchased: %d %s", r.StatusCode, b)
	}
	var mi models.MenuItem
	if err := gdb.Where("id = ?", miID).First(&mi).Error; err != nil {
		t.Fatal(err)
	}
	if !mi.IsPurchased || mi.Station == nil || *mi.Station != "showcase" || !mi.COGS.Equal(decimal.MustFromString("8")) {
		t.Fatalf("после конвертации ожидали purchased+showcase+cogs8, получили is_purchased=%v station=%v cogs=%s", mi.IsPurchased, mi.Station, decimal.Normalize(mi.COGS))
	}
	var lines []models.TechCardLine
	gdb.Where("menu_item_id = ?", miID).Find(&lines)
	if len(lines) != 1 || lines[0].IngredientID == nil {
		t.Fatalf("ожидали 1:1 техкарту, получили %+v", lines)
	}
	var ing models.Ingredient
	gdb.Where("id = ?", *lines[0].IngredientID).First(&ing)
	if !ing.Qty.Equal(decimal.Zero) || !ing.PricePerUnit.Equal(decimal.MustFromString("8")) {
		t.Fatalf("backing-ингредиент: qty=%s price=%s", decimal.Normalize(ing.Qty), decimal.Normalize(ing.PricePerUnit))
	}
}

// Покупной товар со станцией «Бар» должен сохраняться как bar, а не форситься
// в showcase (баг: «Бар» сохранялся как «Витрина»).
func TestMenuPurchased_RespectsBarStation(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// 1) Создание покупного с station=bar → bar.
	r, b := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(), map[string]any{
		"name": "Кола 0.5", "category": "Напитки", "price": "15", "station": "bar",
		"is_purchased": true, "purchase_price": "10", "purchase_unit": "шт",
	})
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Fatalf("create: %d %s", r.StatusCode, b)
	}
	var created struct {
		ID          string `json:"id"`
		Station     string `json:"station"`
		IsPurchased bool   `json:"is_purchased"`
	}
	_ = json.Unmarshal(b, &created)
	if !created.IsPurchased || created.Station != "bar" {
		t.Fatalf("ожидали purchased + station=bar, получили is_purchased=%v station=%q", created.IsPurchased, created.Station)
	}

	// 2) Конвертация обычного блюда в покупное с station=bar → bar.
	miID, name := uuid.NewString(), "Сок"
	if err := gdb.Create(&models.MenuItem{ID: miID, Name: &name, Price: decimal.MustFromString("12"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	r2, b2 := f.patch(t, "/api/v1/menu/items/"+miID, tok, uuid.NewString(), map[string]any{
		"is_purchased": true, "purchase_price": "8", "purchase_unit": "шт", "station": "bar",
	})
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("patch: %d %s", r2.StatusCode, b2)
	}
	var mi models.MenuItem
	gdb.Where("id = ?", miID).First(&mi)
	if mi.Station == nil || *mi.Station != "bar" {
		t.Fatalf("после конвертации с bar ожидали station=bar, получили %v", mi.Station)
	}
}
