//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// createBundleOrder — заказ из одного сета (2 компонента), используя фикстуру
// из bundles_order_test.go. Возвращает заказ + его order_items.
func createBundleOrder(t *testing.T, f *e2eFixture, tok string, bf bundleFixture) (models.Order, []models.OrderItem) {
	t.Helper()
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), bundleSelectionBody(bf))
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create bundle order: %d %s", r.StatusCode, b)
	}
	var order models.Order
	if err := json.Unmarshal(b, &order); err != nil {
		t.Fatal(err)
	}
	gdb := openTestDB(t)
	var items []models.OrderItem
	if err := gdb.Where("order_id = ?", order.ID).Find(&items).Error; err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("setup: order_items count = %d, want 2", len(items))
	}
	return order, items
}

// CancelItem (официант, до-оплатный путь) на ОДНОМ компоненте сета отменяет
// ОБА — картошка не должна остаться висеть в заказе, пока бургер уже отменён.
func TestBundleCancel_CancelItem_CascadesToSiblings(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	bf := setupBundleFixture(t, f, tok)
	order, items := createBundleOrder(t, f, tok, bf)

	// Отменяем ПЕРВЫЙ компонент (неважно какой — оба должны уйти).
	target := items[0]
	r, b := f.post(t, "/api/v1/orders/"+order.ID+"/items/"+target.ID+"/cancel", tok, uuid.NewString(),
		map[string]any{"reason": "гость передумал"})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("cancel item: %d %s", r.StatusCode, b)
	}

	gdb := openTestDB(t)
	var after []models.OrderItem
	if err := gdb.Where("order_id = ?", order.ID).Find(&after).Error; err != nil {
		t.Fatal(err)
	}
	for _, it := range after {
		if it.CancelledAt == nil {
			t.Errorf("позиция %s (menu_item_id=%v) НЕ отменена — каскад по сету не сработал", it.ID, it.MenuItemID)
		}
	}

	// order.total должен уйти в 0 — весь сет отменён, других позиций нет.
	var updatedOrder models.Order
	if err := gdb.Where("id = ?", order.ID).First(&updatedOrder).Error; err != nil {
		t.Fatal(err)
	}
	if !updatedOrder.Total.IsZero() {
		t.Errorf("order.total = %s после отмены всего сета, want 0", updatedOrder.Total.String())
	}
}

// VoidItem (менеджер, с order_voids-аудитом) на ОДНОМ компоненте сета тоже
// каскадит — И заводит запись order_voids на КАЖДЫЙ отменённый компонент, не
// только на тот, что тапнул менеджер (иначе журнал отмен неполный).
func TestBundleCancel_VoidItem_CascadesToSiblings(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	bf := setupBundleFixture(t, f, tok)
	order, items := createBundleOrder(t, f, tok, bf)

	target := items[1]
	r, b := f.post(t, "/api/v1/orders/"+order.ID+"/items/"+target.ID+"/void", tok, uuid.NewString(),
		map[string]any{"reason": "ошибка кассира", "approved_by": "manager-1"})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("void item: %d %s", r.StatusCode, b)
	}

	gdb := openTestDB(t)
	var after []models.OrderItem
	if err := gdb.Where("order_id = ?", order.ID).Find(&after).Error; err != nil {
		t.Fatal(err)
	}
	for _, it := range after {
		if it.CancelledAt == nil {
			t.Errorf("позиция %s НЕ отменена через void-каскад", it.ID)
		}
	}

	var voidsCnt int64
	gdb.Model(&models.OrderVoid{}).Where("order_id = ?", order.ID).Count(&voidsCnt)
	if voidsCnt != 2 {
		t.Errorf("order_voids count = %d, want 2 (аудит на КАЖДЫЙ отменённый компонент сета)", voidsCnt)
	}
}

// Partial (qty-split) отмена компонента сета — 400, а не тихий частичный
// разбор сета (компоненты всегда qty=1, дробить их не имеет смысла).
func TestBundleCancel_PartialCancelOnComponent_Rejected(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	bf := setupBundleFixture(t, f, tok)
	order, items := createBundleOrder(t, f, tok, bf)

	target := items[0]
	r, b := f.post(t, "/api/v1/orders/"+order.ID+"/items/"+target.ID+"/cancel", tok, uuid.NewString(),
		map[string]any{"reason": "тест", "qty": "0.5"})
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("ожидали 400 (partial-cancel компонента сета), получили %d %s", r.StatusCode, b)
	}

	// Ничего не должно было отмениться.
	gdb := openTestDB(t)
	var stillLive int64
	gdb.Model(&models.OrderItem{}).Where("order_id = ? AND cancelled_at IS NULL", order.ID).Count(&stillLive)
	if stillLive != 2 {
		t.Errorf("live-позиций после отклонённого partial = %d, want 2 (ничего не тронуто)", stillLive)
	}
}

// Контроль: отмена ОБЫЧНОЙ (не из сета) позиции НЕ должна цеплять другие
// позиции того же заказа — каскад срабатывает только при bundle_group_id.
func TestBundleCancel_PlainItem_DoesNotCascade(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Второй обычный пункт меню.
	gdb := openTestDB(t)
	friesID, friesName := uuid.NewString(), "Картошка (не сет)"
	if err := gdb.Create(&models.MenuItem{ID: friesID, Name: &friesName, Price: decimal.MustFromString("10000"), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"type": "takeaway", "guests_count": 1,
		"items": []map[string]any{
			{"menu_item_id": menuItemID, "qty": "1"},
			{"menu_item_id": friesID, "qty": "1"},
		},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var order models.Order
	_ = json.Unmarshal(b, &order)

	var items []models.OrderItem
	if err := gdb.Where("order_id = ?", order.ID).Find(&items).Error; err != nil {
		t.Fatal(err)
	}
	if len(items) != 2 {
		t.Fatalf("setup: count=%d, want 2", len(items))
	}

	cr, cb := f.post(t, "/api/v1/orders/"+order.ID+"/items/"+items[0].ID+"/cancel", tok, uuid.NewString(),
		map[string]any{"reason": "тест"})
	if cr.StatusCode != http.StatusOK {
		t.Fatalf("cancel: %d %s", cr.StatusCode, cb)
	}

	var after []models.OrderItem
	gdb.Where("order_id = ?", order.ID).Find(&after)
	liveCount := 0
	for _, it := range after {
		if it.CancelledAt == nil {
			liveCount++
		}
	}
	if liveCount != 1 {
		t.Errorf("live-позиций = %d, want 1 (отменена только та, что тапнули — не каскад)", liveCount)
	}
}
