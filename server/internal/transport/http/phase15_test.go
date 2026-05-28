//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// ─── GET /api/v1/order-items/{id} — точечный lookup, tenant-изоляция через JOIN

func TestPhase15_GetOrderItem(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Создаём open-заказ с одной позицией.
	orderID, _ := phase13_createOrder(t, f, tok, menuItemID, 1)

	// Получаем item.id через детальный GET /orders/{id}.
	r, b := f.get(t, fmt.Sprintf("/api/v1/orders/%s", orderID), tok)
	if r.StatusCode != 200 {
		t.Fatalf("get order: %d %s", r.StatusCode, b)
	}
	var detail struct {
		Items []models.OrderItem `json:"items"`
	}
	if err := json.Unmarshal(b, &detail); err != nil {
		t.Fatalf("decode detail: %v", err)
	}
	if len(detail.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(detail.Items))
	}
	itemID := detail.Items[0].ID

	// GET /order-items/{id} — успех, order_id совпадает.
	r2, b2 := f.get(t, fmt.Sprintf("/api/v1/order-items/%s", itemID), tok)
	if r2.StatusCode != 200 {
		t.Fatalf("get order-item: %d %s", r2.StatusCode, b2)
	}
	var got models.OrderItem
	if err := json.Unmarshal(b2, &got); err != nil {
		t.Fatalf("decode item: %v", err)
	}
	if got.ID != itemID {
		t.Errorf("got id %s, want %s", got.ID, itemID)
	}
	if got.OrderID == nil || *got.OrderID != orderID {
		t.Errorf("got order_id %v, want %s", got.OrderID, orderID)
	}

	// 404 на несуществующий id.
	rNF, _ := f.get(t, "/api/v1/order-items/"+uuid.NewString(), tok)
	if rNF.StatusCode != 404 {
		t.Errorf("expected 404 on missing, got %d", rNF.StatusCode)
	}
}

// ─── GET /api/v1/menu/items?include=tech_cards,ingredient_prices ────────

func TestPhase15_MenuItemsWithIncludes(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	// seedForWrite создаёт ingredient + tech_card_line, привязанные к default menu item.
	_, menuItemID, _, _ := seedForWrite(t, f)

	r, b := f.get(t, "/api/v1/menu/items?limit=500&include=tech_cards,ingredient_prices", tok)
	if r.StatusCode != 200 {
		t.Fatalf("list menu: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []struct {
			ID            string                `json:"id"`
			TechCardLines []models.TechCardLine `json:"tech_card_lines"`
		} `json:"data"`
		IngredientPrices map[string]struct {
			Price        string `json:"price"`
			Unit         string `json:"unit"`
			WastePercent string `json:"waste_percent"`
		} `json:"ingredient_prices"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatalf("decode: %v\n%s", err, b)
	}
	// Найдём целевой пункт меню.
	var found *struct {
		ID            string                `json:"id"`
		TechCardLines []models.TechCardLine `json:"tech_card_lines"`
	}
	for i := range env.Data {
		if env.Data[i].ID == menuItemID {
			found = &env.Data[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("seeded menu item %s not in response", menuItemID)
	}
	if len(found.TechCardLines) == 0 {
		t.Errorf("tech_card_lines empty for seeded item")
	}
	// ingredient_prices содержит цену для ingredient из tech_card_lines.
	if len(env.IngredientPrices) == 0 {
		t.Errorf("ingredient_prices empty")
	}
	if len(found.TechCardLines) > 0 {
		ingID := found.TechCardLines[0].IngredientID
		if ingID == nil {
			t.Fatal("tech card line has no ingredient_id")
		}
		if _, ok := env.IngredientPrices[*ingID]; !ok {
			t.Errorf("ingredient_prices missing entry for %s", *ingID)
		}
	}

	// Без include — поля должны быть пустыми, но присутствовать.
	r2, b2 := f.get(t, "/api/v1/menu/items?limit=500", tok)
	if r2.StatusCode != 200 {
		t.Fatalf("list menu plain: %d %s", r2.StatusCode, b2)
	}
	var env2 struct {
		Data []struct {
			TechCardLines []models.TechCardLine `json:"tech_card_lines"`
		} `json:"data"`
		IngredientPrices map[string]any `json:"ingredient_prices"`
	}
	if err := json.Unmarshal(b2, &env2); err != nil {
		t.Fatalf("decode plain: %v", err)
	}
	for _, it := range env2.Data {
		if len(it.TechCardLines) != 0 {
			t.Errorf("expected empty tech_card_lines without include, got %d", len(it.TechCardLines))
		}
	}
	if len(env2.IngredientPrices) != 0 {
		t.Errorf("expected empty ingredient_prices without include, got %d", len(env2.IngredientPrices))
	}
}
