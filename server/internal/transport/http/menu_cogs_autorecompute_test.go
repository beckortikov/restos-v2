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

// Баг: menu_items.cogs был "заморожен" — POST/PATCH/DELETE /menu/tech-cards
// и PATCH /stock/ingredients (смена цены) не трогали cogs блюда, из-за чего
// список меню (клиентский пересчёт) и реальные продажи (order_items.cogs,
// использующий сохранённый mi.cogs) расходились. Фикс: cogs пересчитывается
// и пишется в БД сразу при мутации тех-карты/цены ингредиента.
func TestCogs_AutoRecomputeOnTechCardAndIngredientPriceChange(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Ингредиент 100/кг.
	r, b := f.post(t, "/api/v1/stock/ingredients", tok, uuid.NewString(), map[string]any{
		"name": "Соус", "unit": "кг", "price_per_unit": "100",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create ingredient: %d %s", r.StatusCode, b)
	}
	var ing models.Ingredient
	if err := json.Unmarshal(b, &ing); err != nil {
		t.Fatal(err)
	}

	// Блюдо без ручной себестоимости и без тех-карты.
	r, b = f.post(t, "/api/v1/menu/items", tok, uuid.NewString(), map[string]any{
		"name": "Блюдо", "price": "50",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create menu item: %d %s", r.StatusCode, b)
	}
	var mi models.MenuItem
	if err := json.Unmarshal(b, &mi); err != nil {
		t.Fatal(err)
	}
	if !mi.COGS.IsZero() {
		t.Fatalf("новое блюдо без тех-карты должно иметь cogs=0, получили %s", mi.COGS)
	}

	// Добавляем строку тех-карты: 100 г соуса → 10. cogs блюда должен
	// обновиться СРАЗУ, без создания заказа.
	r, b = f.post(t, "/api/v1/menu/tech-cards", tok, uuid.NewString(), map[string]any{
		"menu_item_id": mi.ID, "ingredient_id": ing.ID, "name": "Соус", "qty": "100", "unit": "г",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create tech card line: %d %s", r.StatusCode, b)
	}
	var line models.TechCardLine
	if err := json.Unmarshal(b, &line); err != nil {
		t.Fatal(err)
	}

	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	var reloaded models.MenuItem
	if err := gdb.Where("id = ?", mi.ID).First(&reloaded).Error; err != nil {
		t.Fatal(err)
	}
	if !decimal.Normalize(reloaded.COGS).Equal(decimal.MustFromString("10")) {
		t.Fatalf("после POST tech-cards menu_items.cogs = %s, ожидали 10 (100г×100/кг)",
			decimal.Normalize(reloaded.COGS))
	}

	// Цена ингредиента выросла 100 → 200: cogs блюда должен пересчитаться
	// каскадом, без единого обращения к самому блюду.
	r, b = f.patch(t, "/api/v1/stock/ingredients/"+ing.ID, tok, uuid.NewString(), map[string]any{
		"price_per_unit": "200",
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("patch ingredient price: %d %s", r.StatusCode, b)
	}
	if err := gdb.Where("id = ?", mi.ID).First(&reloaded).Error; err != nil {
		t.Fatal(err)
	}
	if !decimal.Normalize(reloaded.COGS).Equal(decimal.MustFromString("20")) {
		t.Fatalf("после PATCH цены ингредиента menu_items.cogs = %s, ожидали 20 (100г×200/кг)",
			decimal.Normalize(reloaded.COGS))
	}

	// Удаляем строку тех-карты — cogs НЕ должен обнулиться (последнее известное
	// значение остаётся, а не "тихо становится бесплатным").
	r, b = f.del(t, "/api/v1/menu/tech-cards/"+line.ID, tok, uuid.NewString())
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusNoContent {
		t.Fatalf("delete tech card line: %d %s", r.StatusCode, b)
	}
	if err := gdb.Where("id = ?", mi.ID).First(&reloaded).Error; err != nil {
		t.Fatal(err)
	}
	if !decimal.Normalize(reloaded.COGS).Equal(decimal.MustFromString("20")) {
		t.Fatalf("после удаления последней строки тех-карты menu_items.cogs = %s, ожидали сохранённые 20",
			decimal.Normalize(reloaded.COGS))
	}
}
