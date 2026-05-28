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

// ═════════════════════════════════════════════════════════════════════════
// F3: CreateOrder — accept item snapshot overrides
// ═════════════════════════════════════════════════════════════════════════

// Verify that passing `price` in items[] overrides server-resolved price.
func TestPhase17_CreateOrder_PriceOverride(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{
			{"menu_item_id": menuItemID, "qty": "1", "price": "999.99", "name": "Custom Item"},
		},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create: %d %s", r.StatusCode, b)
	}
	var created models.Order
	_ = json.Unmarshal(b, &created)
	if !created.Total.Equal(decimal.MustFromString("999.99")) {
		t.Errorf("total = %s, want 999.99 (override applied)", created.Total.String())
	}
	// Verify item price saved.
	_, gb := f.get(t, fmt.Sprintf("/api/v1/orders/%s", created.ID), tok)
	var detail struct {
		Items []models.OrderItem `json:"items"`
	}
	_ = json.Unmarshal(gb, &detail)
	if len(detail.Items) != 1 {
		t.Fatalf("expected 1 item, got %d", len(detail.Items))
	}
	if !detail.Items[0].Price.Equal(decimal.MustFromString("999.99")) {
		t.Errorf("item price = %s, want 999.99", detail.Items[0].Price.String())
	}
	if detail.Items[0].Name == nil || *detail.Items[0].Name != "Custom Item" {
		t.Errorf("item name = %v, want 'Custom Item'", detail.Items[0].Name)
	}
}

// Verify default behavior — no overrides — uses menu snapshot (price=25 from seed).
func TestPhase17_CreateOrder_NoOverride(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{
			{"menu_item_id": menuItemID, "qty": "1"},
		},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create: %d %s", r.StatusCode, b)
	}
	var created models.Order
	_ = json.Unmarshal(b, &created)
	// seedForWrite uses default menu price=25.
	if !created.Total.Equal(decimal.MustFromString("25")) {
		t.Errorf("total = %s, want 25 (menu snapshot)", created.Total.String())
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F7: GET /stock/receipts and /writeoffs — embed lines via ?include=lines
// ═════════════════════════════════════════════════════════════════════════

func TestPhase17_ReceiptsIncludeLines(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Create a receipt + 2 lines directly via DB.
	receiptID := uuid.NewString()
	supName := "Acme"
	if err := gdb.Create(&models.StockReceipt{
		ID: receiptID, SupplierName: &supName,
		TotalAmount:  decimal.MustFromString("100"),
		RestaurantID: &f.rid,
		CreatedAt:    time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}
	rid := receiptID
	name1, name2 := "Rice", "Salt"
	if err := gdb.Create(&models.StockReceiptLine{
		ID: uuid.NewString(), ReceiptID: &rid, Name: &name1,
		Qty: decimal.MustFromString("5"), PricePerUnit: decimal.MustFromString("10"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.StockReceiptLine{
		ID: uuid.NewString(), ReceiptID: &rid, Name: &name2,
		Qty: decimal.MustFromString("2"), PricePerUnit: decimal.MustFromString("25"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// GET without include — no lines field expected (or empty).
	rPlain, bPlain := f.get(t, "/api/v1/stock/receipts?limit=100", tok)
	if rPlain.StatusCode != 200 {
		t.Fatalf("plain: %d %s", rPlain.StatusCode, bPlain)
	}
	// GET with include=lines.
	r, b := f.get(t, "/api/v1/stock/receipts?limit=100&include=lines", tok)
	if r.StatusCode != 200 {
		t.Fatalf("with lines: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []struct {
			ID    string                    `json:"id"`
			Lines []models.StockReceiptLine `json:"lines"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatalf("decode: %v\n%s", err, b)
	}
	var found *struct {
		ID    string                    `json:"id"`
		Lines []models.StockReceiptLine `json:"lines"`
	}
	for i := range env.Data {
		if env.Data[i].ID == receiptID {
			found = &env.Data[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("created receipt not found in list")
	}
	if len(found.Lines) != 2 {
		t.Errorf("expected 2 lines, got %d", len(found.Lines))
	}
}

func TestPhase17_WriteoffsIncludeLines(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	woID := uuid.NewString()
	reason := "spoilage"
	if err := gdb.Create(&models.StockWriteoff{
		ID: woID, Reason: &reason,
		TotalCost: decimal.MustFromString("50"), RestaurantID: &f.rid,
		CreatedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}
	wid := woID
	lname := "Rotten Tomato"
	if err := gdb.Create(&models.StockWriteoffLine{
		ID: uuid.NewString(), WriteoffID: &wid, Name: &lname,
		Qty: decimal.MustFromString("3"), Cost: decimal.MustFromString("50"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.get(t, "/api/v1/stock/writeoffs?limit=100&include=lines", tok)
	if r.StatusCode != 200 {
		t.Fatalf("with lines: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []struct {
			ID    string                     `json:"id"`
			Lines []models.StockWriteoffLine `json:"lines"`
		} `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	var found *struct {
		ID    string                     `json:"id"`
		Lines []models.StockWriteoffLine `json:"lines"`
	}
	for i := range env.Data {
		if env.Data[i].ID == woID {
			found = &env.Data[i]
			break
		}
	}
	if found == nil {
		t.Fatalf("created writeoff not found")
	}
	if len(found.Lines) != 1 {
		t.Errorf("expected 1 line, got %d", len(found.Lines))
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F8 + F9: Semi types with recipe
// ═════════════════════════════════════════════════════════════════════════

func TestPhase17_SemiTypeWithRecipe(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Seed 3 ingredients для recipe lines.
	mkIng := func(n string) string {
		id := uuid.NewString()
		name := n
		unit := "kg"
		if err := gdb.Create(&models.Ingredient{
			ID: id, Name: &name, Unit: &unit, RestaurantID: &f.rid,
		}).Error; err != nil {
			t.Fatal(err)
		}
		return id
	}
	i1, i2, i3 := mkIng("Beef"), mkIng("Carrot"), mkIng("Onion")

	// POST semi type with recipe.
	r, b := f.post(t, "/api/v1/semi/types", tok, uuid.NewString(), map[string]any{
		"name":        "Broth",
		"output_unit": "л",
		"recipe": []map[string]any{
			{"ingredient_id": i1, "name": "Beef", "qty_per_unit": "0.5", "unit": "kg"},
			{"ingredient_id": i2, "name": "Carrot", "qty_per_unit": "0.2", "unit": "kg"},
			{"ingredient_id": i3, "name": "Onion", "qty_per_unit": "0.1", "unit": "kg"},
		},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create: %d %s", r.StatusCode, b)
	}
	var typ models.SemiFinishedType
	_ = json.Unmarshal(b, &typ)

	// GET ?include=recipe.
	rg, bg := f.get(t, fmt.Sprintf("/api/v1/semi/types/%s?include=recipe", typ.ID), tok)
	if rg.StatusCode != 200 {
		t.Fatalf("get: %d %s", rg.StatusCode, bg)
	}
	var got struct {
		ID     string                  `json:"id"`
		Recipe []models.SemiRecipeLine `json:"recipe"`
	}
	_ = json.Unmarshal(bg, &got)
	if len(got.Recipe) != 3 {
		t.Errorf("expected 3 recipe lines, got %d", len(got.Recipe))
	}

	// LIST ?include=recipe — same type should have 3 lines.
	rl, bl := f.get(t, "/api/v1/semi/types?include=recipe", tok)
	if rl.StatusCode != 200 {
		t.Fatalf("list: %d %s", rl.StatusCode, bl)
	}
	var listEnv struct {
		Data []struct {
			ID     string                  `json:"id"`
			Recipe []models.SemiRecipeLine `json:"recipe"`
		} `json:"data"`
	}
	_ = json.Unmarshal(bl, &listEnv)
	var foundInList *struct {
		ID     string                  `json:"id"`
		Recipe []models.SemiRecipeLine `json:"recipe"`
	}
	for i := range listEnv.Data {
		if listEnv.Data[i].ID == typ.ID {
			foundInList = &listEnv.Data[i]
			break
		}
	}
	if foundInList == nil || len(foundInList.Recipe) != 3 {
		t.Errorf("expected 3 lines via list, got %v", foundInList)
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F10: cross-item batch logs
// ═════════════════════════════════════════════════════════════════════════

func TestPhase17_BatchLogsCrossItem(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Seed 2 batch logs для 2 разных menu_items.
	mi1 := uuid.NewString()
	mi2 := uuid.NewString()
	name1, name2 := "Dish 1", "Dish 2"
	q1, q2 := 5, 3
	if err := gdb.Create(&models.BatchCookingLog{
		ID: uuid.NewString(), MenuItemID: &mi1, MenuItemName: &name1, Qty: &q1,
		RestaurantID: &f.rid, CreatedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.BatchCookingLog{
		ID: uuid.NewString(), MenuItemID: &mi2, MenuItemName: &name2, Qty: &q2,
		RestaurantID: &f.rid, CreatedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// GET cross-item (no menu_item_id) — both logs returned.
	r, b := f.get(t, "/api/v1/menu/batch/logs?limit=100", tok)
	if r.StatusCode != 200 {
		t.Fatalf("cross: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []models.BatchCookingLog `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	if len(env.Data) < 2 {
		t.Errorf("expected ≥ 2 cross-item logs, got %d", len(env.Data))
	}

	// GET with menu_item_id filter — only one.
	r2, b2 := f.get(t, "/api/v1/menu/batch/logs?menu_item_id="+mi1, tok)
	if r2.StatusCode != 200 {
		t.Fatalf("filtered: %d %s", r2.StatusCode, b2)
	}
	var env2 struct {
		Data []models.BatchCookingLog `json:"data"`
	}
	_ = json.Unmarshal(b2, &env2)
	for _, l := range env2.Data {
		if l.MenuItemID == nil || *l.MenuItemID != mi1 {
			t.Errorf("filter leak: got log with menu_item_id=%v", l.MenuItemID)
		}
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F13: TimeEntry break_minutes via PATCH
// ═════════════════════════════════════════════════════════════════════════

func TestPhase17_TimeEntryBreakMinutes(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Clock-in.
	rc, bc := f.post(t, "/api/v1/time-entries", tok, uuid.NewString(), map[string]any{
		"user_id": uuid.NewString(),
	})
	if rc.StatusCode != 201 {
		t.Fatalf("clock-in: %d %s", rc.StatusCode, bc)
	}
	var te models.TimeEntry
	_ = json.Unmarshal(bc, &te)

	// PATCH with break_minutes.
	rp, bp := f.patch(t, "/api/v1/time-entries/"+te.ID, tok, uuid.NewString(), map[string]any{
		"break_minutes": 30,
	})
	if rp.StatusCode != 200 {
		t.Fatalf("patch: %d %s", rp.StatusCode, bp)
	}
	var got models.TimeEntry
	_ = json.Unmarshal(bp, &got)
	if got.BreakMinutes == nil || *got.BreakMinutes != 30 {
		t.Errorf("break_minutes = %v, want 30", got.BreakMinutes)
	}
}

// ═════════════════════════════════════════════════════════════════════════
// F14: ModifierGroups filter — global / item / mixed
// ═════════════════════════════════════════════════════════════════════════

func TestPhase17_ModifierGroupsGlobal(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, _, _ := seedForWrite(t, f)

	// Создаём 1 global (menu_item_id NULL) и 1 item-specific.
	gName, sName := "GlobalGroup", "ItemGroup"
	if err := gdb.Create(&models.ModifierGroup{
		ID: uuid.NewString(), Name: &gName, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.ModifierGroup{
		ID: uuid.NewString(), Name: &sName, MenuItemID: &menuItemID, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// GET filtered by menu_item_id — both groups (global+item).
	r, b := f.get(t, "/api/v1/menu/modifier-groups?menu_item_id="+menuItemID, tok)
	if r.StatusCode != 200 {
		t.Fatalf("filtered: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []models.ModifierGroup `json:"data"`
	}
	_ = json.Unmarshal(b, &env)
	gotGlobal, gotSpecific := false, false
	for _, g := range env.Data {
		if g.Name != nil && *g.Name == gName {
			gotGlobal = true
		}
		if g.Name != nil && *g.Name == sName {
			gotSpecific = true
		}
	}
	if !gotGlobal || !gotSpecific {
		t.Errorf("expected both global and item-specific; got global=%v specific=%v", gotGlobal, gotSpecific)
	}

	// GET ?menu_item_id=global — only global.
	rg, bg := f.get(t, "/api/v1/menu/modifier-groups?menu_item_id=global", tok)
	if rg.StatusCode != 200 {
		t.Fatalf("global: %d %s", rg.StatusCode, bg)
	}
	var envG struct {
		Data []models.ModifierGroup `json:"data"`
	}
	_ = json.Unmarshal(bg, &envG)
	for _, g := range envG.Data {
		if g.MenuItemID != nil {
			t.Errorf("global filter leak: got group with menu_item_id=%v", g.MenuItemID)
		}
	}
}
