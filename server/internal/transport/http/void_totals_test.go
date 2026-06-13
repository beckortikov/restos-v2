//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// ─── Helpers ────────────────────────────────────────────────────────────────

type vtItem struct {
	ID          string          `json:"id"`
	Name        string          `json:"name"`
	Price       decimal.Decimal `json:"price"`
	Qty         decimal.Decimal `json:"qty"`
	Unit        *string         `json:"unit"`
	UnitSize    decimal.Decimal `json:"unit_size"`
	CancelledAt *string         `json:"cancelled_at"`
}

type vtVoid struct {
	ItemName  string          `json:"item_name"`
	ItemPrice decimal.Decimal `json:"item_price"`
	ItemQty   int             `json:"item_qty"`
}

// lineTotal — порт lib/helpers.ts calcLineTotal: piece → price*qty,
// весовые → price*(qty/unitSize).
func vtLineTotal(it vtItem) decimal.Decimal {
	if it.Unit != nil && (*it.Unit == "g" || *it.Unit == "kg") {
		size := it.UnitSize
		if !size.IsPositive() {
			size = decimal.FromInt(1)
		}
		return decimal.Mul(it.Price, decimal.DivRound(it.Qty, size))
	}
	return decimal.Mul(it.Price, it.Qty)
}

// visibleSubtotal — Go-порт lib/helpers.ts visibleReceiptItems + сумма по нему.
// Исключает позиции с cancelled_at и списанные через order_voids (матч по
// name|price, all-or-nothing по бакету qty). Это РОВНО та логика, по которой
// фронт (диалог оплаты) считает подытог из order.items + order_voids.
func visibleSubtotal(items []vtItem, voids []vtVoid) decimal.Decimal {
	voidedQty := map[string]int{}
	for _, v := range voids {
		key := fmt.Sprintf("%s|%s", v.ItemName, v.ItemPrice.String())
		voidedQty[key] += v.ItemQty
	}
	sum := decimal.Zero
	for _, it := range items {
		if it.CancelledAt != nil {
			continue
		}
		key := fmt.Sprintf("%s|%s", it.Name, it.Price.String())
		voided := voidedQty[key]
		if voided > 0 {
			qtyInt := int(it.Qty.IntPart())
			if voided >= qtyInt {
				voidedQty[key] = voided - qtyInt
				continue // позиция полностью списана
			}
			voidedQty[key] = 0
		}
		sum = decimal.Add(sum, vtLineTotal(it))
	}
	return decimal.Normalize(sum)
}

// seedManager — пользователь с ролью manager (для approved_by в скидках ≥10%).
func seedManager(t *testing.T, gdb *gorm.DB, rid string) string {
	t.Helper()
	id := uuid.NewString()
	name, pin, role := "Manager", "9999", "manager"
	if err := gdb.Create(&models.User{
		ID: id, Name: &name, PIN: &pin, Role: &role, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return id
}

func vtCreateMenuItem(t *testing.T, gdb *gorm.DB, rid, name, price string) string {
	t.Helper()
	mi := &models.MenuItem{
		ID: uuid.NewString(), Name: &name,
		Price: decimal.MustFromString(price), RestaurantID: &rid,
	}
	if err := gdb.Create(mi).Error; err != nil {
		t.Fatal(err)
	}
	return mi.ID
}

// vtFetch — деталь заказа: order.total (скаляр, что отдаёт API карте/официанту),
// items и voids.
func vtFetch(t *testing.T, f *e2eFixture, tok, orderID string) (decimal.Decimal, []vtItem, []vtVoid) {
	t.Helper()
	_, body := f.get(t, "/api/v1/orders/"+orderID, tok)
	var detail struct {
		Order struct {
			Total decimal.Decimal `json:"total"`
		} `json:"order"`
		Items []vtItem `json:"items"`
		Voids []vtVoid `json:"voids"`
	}
	if err := json.Unmarshal(body, &detail); err != nil {
		t.Fatalf("unmarshal detail: %v", err)
	}
	return detail.Order.Total, detail.Items, detail.Voids
}

// vtSlimTotal — order.total из slim-списка (тот путь, которым карта столов и
// официант тянут заказы: fetchOrders slim).
func vtSlimTotal(t *testing.T, f *e2eFixture, tok, orderID string) decimal.Decimal {
	t.Helper()
	_, body := f.get(t, "/api/v1/orders?status=open", tok)
	var env struct {
		Data []struct {
			ID    string          `json:"id"`
			Total decimal.Decimal `json:"total"`
		} `json:"data"`
	}
	_ = json.Unmarshal(body, &env)
	for _, o := range env.Data {
		if o.ID == orderID {
			return o.Total
		}
	}
	t.Fatalf("order %s не найден в slim-списке", orderID)
	return decimal.Zero
}

func vtVoidFullItem(t *testing.T, f *e2eFixture, tok, orderID string, it vtItem) {
	t.Helper()
	r, b := f.post(t, "/api/v1/voids", tok, uuid.NewString(), map[string]any{
		"order_id":   orderID,
		"item_name":  it.Name,
		"item_price": it.Price.String(),
		"item_qty":   int(it.Qty.IntPart()),
		"reason":     "guest_changed_mind",
	})
	if r.StatusCode != 201 {
		t.Fatalf("void item %s: %d %s", it.Name, r.StatusCode, b)
	}
}

// assertConsistent — главный инвариант: order.total из API (detail И slim) ==
// подытогу видимых позиций, который считает фронт. Если он держится — карта,
// официант и диалог оплаты показывают одинаковую сумму.
func vtAssertConsistent(t *testing.T, f *e2eFixture, tok, orderID, label string) {
	t.Helper()
	total, items, voids := vtFetch(t, f, tok, orderID)
	want := visibleSubtotal(items, voids)
	if total.Cmp(want) != 0 {
		t.Errorf("%s: detail order.total=%s, а сумма видимых позиций (фронт)=%s — расходятся",
			label, total, want)
	}
	if slim := vtSlimTotal(t, f, tok, orderID); slim.Cmp(total) != 0 {
		t.Errorf("%s: slim order.total=%s ≠ detail order.total=%s", label, slim, total)
	}
}

// ─── Тест ─────────────────────────────────────────────────────────────────

// TestVoidTotals_ApiFrontConsistency — несколько заказов, отмена позиций,
// сверка итогов. Проверяет, что после void'ов скаляр order.total (его читают
// карта/официант) совпадает с подытогом по неотменённым позициям (его считает
// диалог оплаты на фронте). До фикса CreateVoid total не уменьшался → расхождение.
func TestVoidTotals_ApiFrontConsistency(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, miPlov, _, _ := seedForWrite(t, f) // Plov = 25

	// Ещё две позиции с разными ценами, чтобы в заказе были отдельные строки
	// (одинаковые схлопываются в одну — отдельный баг).
	miLagman := vtCreateMenuItem(t, gdb, f.rid, "Lagman", "40")
	miTea := vtCreateMenuItem(t, gdb, f.rid, "Tea", "8")

	create := func(items []map[string]any) string {
		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{"items": items})
		if r.StatusCode != 201 {
			t.Fatalf("create order: %d %s", r.StatusCode, b)
		}
		var o models.Order
		_ = json.Unmarshal(b, &o)
		return o.ID
	}

	// ── Заказ 1: Plov×2 (50) + Lagman×1 (40) = 90. Отменяем Lagman → 50.
	o1 := create([]map[string]any{
		{"menu_item_id": miPlov, "qty": "2"},
		{"menu_item_id": miLagman, "qty": "1"},
	})
	vtAssertConsistent(t, f, tok, o1, "заказ1 до отмены")
	if total, _, _ := vtFetch(t, f, tok, o1); total.Cmp(decimal.FromInt(90)) != 0 {
		t.Fatalf("заказ1: ожидался total=90, получили %s", total)
	}
	_, items1, _ := vtFetch(t, f, tok, o1)
	for _, it := range items1 {
		if it.Name == "Lagman" {
			vtVoidFullItem(t, f, tok, o1, it)
		}
	}
	vtAssertConsistent(t, f, tok, o1, "заказ1 после отмены Lagman")
	if total, _, _ := vtFetch(t, f, tok, o1); total.Cmp(decimal.FromInt(50)) != 0 {
		t.Errorf("заказ1 после отмены: ожидался total=50, получили %s", total)
	}

	// ── Заказ 2: Plov×1 (25) + Lagman×2 (80) + Tea×3 (24) = 129.
	//    Отменяем Plov и Tea → остаётся Lagman×2 = 80.
	o2 := create([]map[string]any{
		{"menu_item_id": miPlov, "qty": "1"},
		{"menu_item_id": miLagman, "qty": "2"},
		{"menu_item_id": miTea, "qty": "3"},
	})
	vtAssertConsistent(t, f, tok, o2, "заказ2 до отмены")
	_, items2, _ := vtFetch(t, f, tok, o2)
	for _, it := range items2 {
		if it.Name == "Plov" || it.Name == "Tea" {
			vtVoidFullItem(t, f, tok, o2, it)
		}
	}
	vtAssertConsistent(t, f, tok, o2, "заказ2 после отмены Plov+Tea")
	if total, _, _ := vtFetch(t, f, tok, o2); total.Cmp(decimal.FromInt(80)) != 0 {
		t.Errorf("заказ2 после отмены: ожидался total=80, получили %s", total)
	}

	// ── Заказ 3: Plov×2 (50). Отменяем всё → заказ авто-отменяется, total=0.
	o3 := create([]map[string]any{{"menu_item_id": miPlov, "qty": "2"}})
	_, items3, _ := vtFetch(t, f, tok, o3)
	for _, it := range items3 {
		vtVoidFullItem(t, f, tok, o3, it)
	}
	total3, items3after, voids3 := vtFetch(t, f, tok, o3)
	if total3.Cmp(decimal.Zero) != 0 {
		t.Errorf("заказ3 после полной отмены: ожидался total=0, получили %s", total3)
	}
	if want := visibleSubtotal(items3after, voids3); want.Cmp(total3) != 0 {
		t.Errorf("заказ3: order.total=%s ≠ видимый подытог=%s", total3, want)
	}
}
