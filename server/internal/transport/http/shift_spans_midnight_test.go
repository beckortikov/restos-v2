//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Смена, идущая через полночь, не должна ронять нумерацию чеков на #1 и не
// должна терять заказы с /kds/items — граница «новый день» теперь привязана к
// ОТКРЫТОЙ СМЕНЕ (shift_id), а не к календарной дате/часам сервера. Смотри
// server/internal/service/orders_write.go (счётчик) и kds.go (ListItems).

// openShiftAt — открытая смена с явным opened_at (для симуляции «смена началась
// вчера, ещё идёт»). t0 — момент открытия.
func openShiftAt(t *testing.T, gdb *gorm.DB, rid string, t0 time.Time) string {
	t.Helper()
	shiftID := uuid.NewString()
	openStatus, openedBy := "open", "test"
	if err := gdb.Create(&models.CashShift{
		ID: shiftID, RestaurantID: &rid, Status: &openStatus,
		OpenedBy: &openedBy, OpeningBalance: decimal.MustFromString("0"),
		OpenedAt: t0, UpdatedAt: t0,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return shiftID
}

// Счётчик номеров ключуется днём ОТКРЫТИЯ СМЕНЫ: два заказа одной смены,
// открытой «вчера» (относительно момента прогона теста), получают
// последовательные номера, а служебная строка order_counters сохраняет ДАТУ
// СМЕНЫ, а не сегодняшнюю календарную дату. Новая, отдельная смена (открыта
// «сейчас») — свой независимый счётчик с 1.
func TestOrderCounter_ContinuesAcrossShiftSpanningMidnight(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	var menuItemID string
	if err := gdb.Model(&models.MenuItem{}).Where("restaurant_id = ?", f.rid).
		Select("id").Scan(&menuItemID).Error; err != nil || menuItemID == "" {
		t.Fatal("no seeded menu item")
	}

	// Смена «через полночь»: открыта позавчера вечером, всё ещё open.
	yesterday := time.Now().UTC().Add(-30 * time.Hour)
	shiftA := openShiftAt(t, gdb, f.rid, yesterday)

	createOrder := func(t *testing.T, shiftID string) int {
		t.Helper()
		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
			"type": "hall", "guests_count": 1, "shift_id": shiftID,
			"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
		})
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("create order: %d %s", r.StatusCode, b)
		}
		var o models.Order
		if err := json.Unmarshal(b, &o); err != nil {
			t.Fatal(err)
		}
		return o.OrderNumber
	}

	n1 := createOrder(t, shiftA)
	n2 := createOrder(t, shiftA)
	if n1 != 1 || n2 != 2 {
		t.Fatalf("смена А (открыта вчера): ожидали #1, #2 подряд, получили #%d, #%d", n1, n2)
	}

	// Ключевая проверка: счётчик привязан к ДНЮ СМЕНЫ, не к реальному «сегодня».
	var counterDate time.Time
	if err := gdb.Table("order_counters").
		Select("date").Where("restaurant_id = ?", f.rid).
		Scan(&counterDate).Error; err != nil {
		t.Fatal(err)
	}
	if counterDate.Format("2006-01-02") != yesterday.Format("2006-01-02") {
		t.Fatalf("order_counters.date = %s, ожидали день открытия смены %s (не реальное «сегодня») — счётчик не привязан к смене",
			counterDate.Format("2006-01-02"), yesterday.Format("2006-01-02"))
	}

	// Другая, независимая смена (открыта «сейчас») — свой счётчик с 1, старая
	// смена не сбрасывается и не мешает новой.
	shiftB := openShiftAt(t, gdb, f.rid, time.Now().UTC())
	n3 := createOrder(t, shiftB)
	if n3 != 1 {
		t.Fatalf("новая независимая смена должна начинать счётчик с 1, получили #%d", n3)
	}
	n4 := createOrder(t, shiftA)
	if n4 != 3 {
		t.Fatalf("смена А должна продолжить счёт (#3) независимо от смены Б, получили #%d", n4)
	}
}

// /kds/items не должен терять заказ только потому, что его created_at «вчера»,
// пока смена, открытая ДО этого заказа, ещё не закрыта. Граница — время
// открытия самой ранней открытой смены, НЕ shift_id: официантские заказы с
// Kotlin-планшета создаются без привязки к кассовой смене, и жёсткий фильтр по
// shift_id уже один раз ломал именно этот сценарий (см. комментарий в
// kds.go/pos2/order/page.tsx) — поэтому и заказ БЕЗ смены, но созданный внутри
// её временно́го окна, тоже должен остаться видимым.
func TestKDS_ItemsVisible_AcrossShiftSpanningMidnight(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	var menuItemID string
	if err := gdb.Model(&models.MenuItem{}).Where("restaurant_id = ?", f.rid).
		Select("id").Scan(&menuItemID).Error; err != nil || menuItemID == "" {
		t.Fatal("no seeded menu item")
	}
	dishName := "Плов"
	_ = gdb.Model(&models.MenuItem{}).Where("id = ?", menuItemID).Update("name", dishName)

	now := time.Now().UTC()
	shiftOpenedAt := now.Add(-30 * time.Hour) // смена открыта «вчера», идёт через полночь
	shiftID := openShiftAt(t, gdb, f.rid, shiftOpenedAt)

	openStatus, hallType := "open", "hall"
	makeOrderItem := func(t *testing.T, num int, shiftID *string, createdAt time.Time) string {
		t.Helper()
		oid := uuid.NewString()
		if err := gdb.Create(&models.Order{
			ID: oid, RestaurantID: &f.rid, Status: &openStatus, Type: &hallType,
			ShiftID: shiftID, OrderNumber: num, CreatedAt: createdAt,
		}).Error; err != nil {
			t.Fatal(err)
		}
		itemID := uuid.NewString()
		if err := gdb.Create(&models.OrderItem{
			ID: itemID, OrderID: &oid, MenuItemID: &menuItemID,
			Name: &dishName, Qty: decimal.MustFromString("1"), CreatedAt: createdAt,
		}).Error; err != nil {
			t.Fatal(err)
		}
		return itemID
	}

	// Заказ ЭТОЙ смены, создан «вчера» (внутри окна смены, до полуночи).
	itemInShift := makeOrderItem(t, 1, &shiftID, shiftOpenedAt.Add(2*time.Hour))

	// Заказ БЕЗ смены (как официант с Kotlin-планшета — без кассовой смены),
	// но создан ВНУТРИ окна той же смены — тоже должен быть виден.
	itemOrderlessInWindow := makeOrderItem(t, 2, nil, shiftOpenedAt.Add(3*time.Hour))

	// Контроль: заказ ДО открытия смены (реально старый мусор — тот случай,
	// от которого исходный startOfToday-фильтр защищал) — должен остаться скрыт.
	stale := makeOrderItem(t, 3, nil, shiftOpenedAt.Add(-10*time.Hour))

	r, b := f.get(t, "/api/v1/kds/items", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("list: %d %s", r.StatusCode, b)
	}
	var env struct {
		Data []map[string]any `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatal(err)
	}
	seen := map[string]bool{}
	for _, it := range env.Data {
		if id, _ := it["id"].(string); id != "" {
			seen[id] = true
		}
	}
	if !seen[itemInShift] {
		t.Errorf("позиция заказа ОТКРЫТОЙ смены (создан «вчера») пропала с /kds/items — смена ещё не закрыта, теряться не должна")
	}
	if !seen[itemOrderlessInWindow] {
		t.Errorf("позиция заказа БЕЗ смены, но внутри окна открытой смены (напр. официант с планшета), пропала — жёсткий фильтр по shift_id уже один раз ломал этот сценарий, регрессия")
	}
	if seen[stale] {
		t.Errorf("позиция, созданная ДО открытия смены (реально старый мусор), не должна показываться")
	}
}
