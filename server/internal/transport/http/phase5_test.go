//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// helper: создаём заказ с N позициями по цене 25 каждая.
// Возвращает order и его item IDs.
func createTestOrder(t *testing.T, f *e2eFixture, tok, menuItemID string, qtyEach int) (models.Order, []string) {
	t.Helper()
	items := make([]map[string]any, qtyEach)
	for i := 0; i < qtyEach; i++ {
		items[i] = map[string]any{"menu_item_id": menuItemID, "qty": "1"}
	}
	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": items})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var order models.Order
	_ = json.Unmarshal(body, &order)

	// fetch items.
	gr, gb := f.get(t, "/api/v1/orders/"+order.ID, tok)
	if gr.StatusCode != 200 {
		t.Fatal(gr.StatusCode)
	}
	var detail struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	_ = json.Unmarshal(gb, &detail)
	ids := make([]string, len(detail.Items))
	for i, it := range detail.Items {
		ids[i] = it.ID
	}
	return order, ids
}

// TestPhase5_SplitEqual — equal split, total делится на N равных частей.
func TestPhase5_SplitEqual(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	order, _ := createTestOrder(t, f, tok, menuItemID, 4) // 4 × 25 = 100

	splitPath := fmt.Sprintf("/api/v1/orders/%s/split", order.ID)
	resp, body := f.post(t, splitPath, tok, uuid.NewString(),
		map[string]any{"mode": "equal", "count": 4})
	if resp.StatusCode != 200 {
		t.Fatalf("split %d: %s", resp.StatusCode, body)
	}
	var res struct {
		Order  models.Order        `json:"order"`
		Splits []models.OrderSplit `json:"splits"`
	}
	_ = json.Unmarshal(body, &res)

	if len(res.Splits) != 4 {
		t.Fatalf("want 4 splits, got %d", len(res.Splits))
	}
	if res.Order.IsSplit == nil || !*res.Order.IsSplit {
		t.Errorf("order.is_split should be true")
	}
	if res.Order.SplitCount == nil || *res.Order.SplitCount != 4 {
		t.Errorf("split_count = %v, want 4", res.Order.SplitCount)
	}

	// Сумма всех splits = total.
	sum := decimal.Zero
	for _, s := range res.Splits {
		sum = decimal.Add(sum, s.Total)
	}
	if !sum.Equal(decimal.MustFromString("100")) {
		t.Errorf("sum of splits = %s, want 100", sum.String())
	}

	// Каждый split = 25.
	for i, s := range res.Splits {
		if !s.Total.Equal(decimal.MustFromString("25")) {
			t.Errorf("split[%d].total = %s, want 25", i, s.Total.String())
		}
	}

	// Double split → 409.
	resp2, _ := f.post(t, splitPath, tok, uuid.NewString(),
		map[string]any{"mode": "equal", "count": 2})
	if resp2.StatusCode != 409 {
		t.Errorf("double split expected 409, got %d", resp2.StatusCode)
	}
}

// TestPhase5_SplitEqualRoundingFairness — 100/3 = 33.33... → 33.33, 33.33, 33.34
// (последняя часть компенсирует rounding).
func TestPhase5_SplitEqualRoundingFairness(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	order, _ := createTestOrder(t, f, tok, menuItemID, 4) // total = 100

	splitPath := fmt.Sprintf("/api/v1/orders/%s/split", order.ID)
	resp, body := f.post(t, splitPath, tok, uuid.NewString(),
		map[string]any{"mode": "equal", "count": 3})
	if resp.StatusCode != 200 {
		t.Fatalf("split %d: %s", resp.StatusCode, body)
	}
	var res struct {
		Splits []models.OrderSplit `json:"splits"`
	}
	_ = json.Unmarshal(body, &res)

	if len(res.Splits) != 3 {
		t.Fatal(len(res.Splits))
	}
	sum := decimal.Zero
	for _, s := range res.Splits {
		sum = decimal.Add(sum, s.Total)
	}
	if !sum.Equal(decimal.MustFromString("100")) {
		t.Errorf("sum = %s, want 100 (rounding compensation broken)", sum.String())
	}
}

// TestPhase5_SplitByItems — выбираем 2 из 3 items в первый split, 1 — во второй.
func TestPhase5_SplitByItems(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	order, itemIDs := createTestOrder(t, f, tok, menuItemID, 3) // 3 × 25 = 75
	if len(itemIDs) != 3 {
		t.Fatalf("want 3 items, got %d", len(itemIDs))
	}

	splitPath := fmt.Sprintf("/api/v1/orders/%s/split", order.ID)
	resp, body := f.post(t, splitPath, tok, uuid.NewString(),
		map[string]any{
			"mode": "by_items",
			"splits": []map[string]any{
				{"item_ids": []string{itemIDs[0], itemIDs[1]}},
				{"item_ids": []string{itemIDs[2]}},
			},
		})
	if resp.StatusCode != 200 {
		t.Fatalf("split %d: %s", resp.StatusCode, body)
	}
	var res struct {
		Order  models.Order        `json:"order"`
		Splits []models.OrderSplit `json:"splits"`
	}
	_ = json.Unmarshal(body, &res)
	if len(res.Splits) != 2 {
		t.Fatalf("want 2 splits, got %d", len(res.Splits))
	}
	if !res.Splits[0].Total.Equal(decimal.MustFromString("50")) {
		t.Errorf("split[0].total = %s, want 50", res.Splits[0].Total.String())
	}
	if !res.Splits[1].Total.Equal(decimal.MustFromString("25")) {
		t.Errorf("split[1].total = %s, want 25", res.Splits[1].Total.String())
	}

	// Validation: попытка положить один item в два split'а.
	respDup, _ := f.post(t, splitPath, tok, uuid.NewString(),
		map[string]any{
			"mode": "by_items",
			"splits": []map[string]any{
				{"item_ids": []string{itemIDs[0]}},
				{"item_ids": []string{itemIDs[0]}},
			},
		})
	// Это новая попытка split'а на уже split-нутый заказ → 409 уже из-за is_split.
	if respDup.StatusCode != 409 {
		t.Errorf("on split-already → 409, got %d", respDup.StatusCode)
	}
}

// TestPhase5_SplitValidation — equal count<2 → 400, by_items с unknown item → 400.
func TestPhase5_SplitValidation(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)
	order, _ := createTestOrder(t, f, tok, menuItemID, 2)
	splitPath := fmt.Sprintf("/api/v1/orders/%s/split", order.ID)

	// equal count=1.
	resp, _ := f.post(t, splitPath, tok, uuid.NewString(),
		map[string]any{"mode": "equal", "count": 1})
	if resp.StatusCode != 400 {
		t.Errorf("count=1 expected 400, got %d", resp.StatusCode)
	}

	// unknown mode.
	resp2, _ := f.post(t, splitPath, tok, uuid.NewString(),
		map[string]any{"mode": "magic"})
	if resp2.StatusCode != 400 {
		t.Errorf("bad mode expected 400, got %d", resp2.StatusCode)
	}

	// by_items с фальш item_id.
	resp3, _ := f.post(t, splitPath, tok, uuid.NewString(),
		map[string]any{
			"mode": "by_items",
			"splits": []map[string]any{
				{"item_ids": []string{uuid.NewString()}},
				{"item_ids": []string{uuid.NewString()}},
			},
		})
	if resp3.StatusCode != 400 {
		t.Errorf("unknown item expected 400, got %d", resp3.StatusCode)
	}
}

// TestPhase5_TransferTable — смена стола.
func TestPhase5_TransferTable(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	// Создаём 2 стола.
	t1ID := uuid.NewString()
	t2ID := uuid.NewString()
	zoneID := uuid.NewString()
	zoneName := "Zone"
	if err := gdb.Create(&models.Zone{ID: zoneID, Name: zoneName, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	n1, n2 := 1, 2
	if err := gdb.Create(&models.Table{ID: t1ID, Number: &n1, ZoneID: &zoneID, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.Table{ID: t2ID, Number: &n2, ZoneID: &zoneID, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	// Заказ на t1.
	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{
			"table_id": t1ID,
			"items":    []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
		})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var order models.Order
	_ = json.Unmarshal(body, &order)
	if order.TableID == nil || *order.TableID != t1ID {
		t.Fatalf("created order has wrong table: %v", order.TableID)
	}

	// Transfer на t2.
	transferPath := fmt.Sprintf("/api/v1/orders/%s/transfer", order.ID)
	resp2, body2 := f.post(t, transferPath, tok, uuid.NewString(),
		map[string]any{"table_id": t2ID})
	if resp2.StatusCode != 200 {
		t.Fatalf("transfer %d: %s", resp2.StatusCode, body2)
	}
	var transferred models.Order
	_ = json.Unmarshal(body2, &transferred)
	if transferred.TableID == nil || *transferred.TableID != t2ID {
		t.Errorf("table_id after transfer = %v, want %s", transferred.TableID, t2ID)
	}

	// Transfer на несуществующий стол → 400.
	resp3, _ := f.post(t, transferPath, tok, uuid.NewString(),
		map[string]any{"table_id": uuid.NewString()})
	if resp3.StatusCode != 400 {
		t.Errorf("transfer to nonexistent table expected 400, got %d", resp3.StatusCode)
	}
}

// TestPhase5_TransferClosedOrder — нельзя.
func TestPhase5_TransferClosedOrder(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)
	_ = gdb

	// Создаём + закрываем заказ.
	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}}})
	if resp.StatusCode != 201 {
		t.Fatal(resp.StatusCode)
	}
	var order models.Order
	_ = json.Unmarshal(body, &order)

	closePath := fmt.Sprintf("/api/v1/orders/%s/close", order.ID)
	respC, _ := f.post(t, closePath, tok, uuid.NewString(),
		map[string]any{"payment_method": "cash", "account_id": accountID, "shift_id": shiftID})
	if respC.StatusCode != 200 {
		t.Fatal(respC.StatusCode)
	}

	// Transfer на любой стол → 409.
	tID := uuid.NewString()
	if err := gdb.Create(&models.Table{ID: tID, RestaurantID: &f.rid, UpdatedAt: time.Now()}).Error; err != nil {
		t.Fatal(err)
	}
	transferPath := fmt.Sprintf("/api/v1/orders/%s/transfer", order.ID)
	resp2, _ := f.post(t, transferPath, tok, uuid.NewString(),
		map[string]any{"table_id": tID})
	if resp2.StatusCode != 409 {
		t.Errorf("transfer-closed expected 409, got %d", resp2.StatusCode)
	}
}
