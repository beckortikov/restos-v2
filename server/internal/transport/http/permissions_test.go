//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
)

// Матрица доступов теперь enforced на бэке. Проверяем, что отмена позиции (void)
// блокируется для роли без права orders.void (официант) и разрешена тем, у кого
// оно есть. Раньше бэк права игнорировал — официант мог отменять блюда.

// makeUserToken — создаёт юзера (role, pin, опц. permissions JSON) в ресторане
// фикстуры и логинится под ним, возвращает токен.
func makeUserToken(t *testing.T, f *e2eFixture, role, pin, permsJSON string) string {
	t.Helper()
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	name := role + "-" + pin
	r := role
	p := pin
	u := &models.User{
		ID: uuid.NewString(), Name: &name, PIN: &p, Role: &r, RestaurantID: &f.rid,
	}
	if permsJSON != "" {
		u.Permissions = datatypes.JSON([]byte(permsJSON))
	}
	if err := gdb.Create(u).Error; err != nil {
		t.Fatal(err)
	}
	body, _ := json.Marshal(map[string]string{"restaurant_id": f.rid, "pin": pin})
	resp, err := http.Post(f.srv.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("login %s: %d %s", role, resp.StatusCode, b)
	}
	var out struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	if out.Token == "" {
		t.Fatalf("empty token for %s", role)
	}
	return out.Token
}

// makeOrderItem — создаёт заказ с одной позицией (под токеном фикстуры) и
// возвращает (orderID, itemID).
func makeOrderItem(t *testing.T, f *e2eFixture, tok string) (string, string) {
	t.Helper()
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": menuItemIDFor(t, f), "qty": "1"}}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)
	_, gb := f.get(t, "/api/v1/orders/"+ord.ID, tok)
	var d struct {
		Items []struct {
			ID string `json:"id"`
		} `json:"items"`
	}
	_ = json.Unmarshal(gb, &d)
	if len(d.Items) == 0 {
		t.Fatalf("no items in order")
	}
	return ord.ID, d.Items[0].ID
}

func menuItemIDFor(t *testing.T, f *e2eFixture) string {
	t.Helper()
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	var mi models.MenuItem
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&mi).Error; err != nil {
		t.Fatal(err)
	}
	return mi.ID
}

func voidItem(t *testing.T, f *e2eFixture, tok, orderID, itemID string) int {
	t.Helper()
	r, _ := f.post(t, fmt.Sprintf("/api/v1/orders/%s/items/%s/void", orderID, itemID), tok, uuid.NewString(),
		map[string]any{"reason": "test"})
	return r.StatusCode
}

// loginPerms — POST /auth/login и парсит user.permissions.actions.
func loginPerms(t *testing.T, f *e2eFixture, pin string) map[string]bool {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"restaurant_id": f.rid, "pin": pin})
	resp, err := http.Post(f.srv.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	var out struct {
		User struct {
			Permissions struct {
				Actions map[string]bool `json:"actions"`
			} `json:"permissions"`
		} `json:"user"`
	}
	if err := json.NewDecoder(resp.Body).Decode(&out); err != nil {
		t.Fatal(err)
	}
	return out.User.Permissions.Actions
}

// TestPerms_LoginReturnsEffective — login отдаёт эффективные права, чтобы клиент
// (Kotlin) мог прятать недоступные кнопки.
func TestPerms_LoginReturnsEffective(t *testing.T) {
	f := setupE2E(t)
	_ = makeUserToken(t, f, "waiter", "5551", "")
	wa := loginPerms(t, f, "5551")
	if wa["orders.void"] || wa["orders.cancel"] {
		t.Fatalf("официант: orders.void/cancel должны быть false, got %+v", wa)
	}
	if !wa["orders.create"] {
		t.Fatalf("официант: orders.create должно быть true, got %+v", wa)
	}
	_ = makeUserToken(t, f, "cashier", "5552", "")
	ca := loginPerms(t, f, "5552")
	if !ca["orders.void"] {
		t.Fatalf("кассир: orders.void должно быть true, got %+v", ca)
	}
	if ca["orders.cancel"] {
		t.Fatalf("кассир: orders.cancel должно быть false, got %+v", ca)
	}
}

func TestPerms_WaiterCannotVoid(t *testing.T) {
	f := setupE2E(t)
	fixTok := f.login(t) // cashier-фикстура с правами — создаёт заказ

	// Официант без прав (дефолт роли: нет orders.void).
	waiterTok := makeUserToken(t, f, "waiter", "1111", "")
	orderID, itemID := makeOrderItem(t, f, fixTok)
	if code := voidItem(t, f, waiterTok, orderID, itemID); code != http.StatusForbidden {
		t.Fatalf("официант без права orders.void должен получить 403, получили %d", code)
	}
}

func TestPerms_ManagerCanVoid(t *testing.T) {
	f := setupE2E(t)
	fixTok := f.login(t)
	mgrTok := makeUserToken(t, f, "manager", "2222", "")
	orderID, itemID := makeOrderItem(t, f, fixTok)
	if code := voidItem(t, f, mgrTok, orderID, itemID); code != http.StatusOK {
		t.Fatalf("менеджер должен мочь void, получили %d", code)
	}
}

func TestPerms_WaiterWithExplicitGrantCanVoid(t *testing.T) {
	f := setupE2E(t)
	fixTok := f.login(t)
	// Официанту явно включили право в матрице.
	waiterTok := makeUserToken(t, f, "waiter", "3333", `{"actions":{"orders.void":true}}`)
	orderID, itemID := makeOrderItem(t, f, fixTok)
	if code := voidItem(t, f, waiterTok, orderID, itemID); code != http.StatusOK {
		t.Fatalf("официант с явным orders.void должен мочь, получили %d", code)
	}
}

func TestPerms_CashierCannotCancelWholeOrder(t *testing.T) {
	f := setupE2E(t)
	fixTok := f.login(t)
	// Чистый кассир (дефолт роли: нет orders.cancel).
	cashTok := makeUserToken(t, f, "cashier", "4444", "")
	orderID, _ := makeOrderItem(t, f, fixTok)
	r, _ := f.post(t, fmt.Sprintf("/api/v1/orders/%s/cancel", orderID), cashTok, uuid.NewString(),
		map[string]any{"reason": "test"})
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("кассир без orders.cancel должен получить 403, получили %d", r.StatusCode)
	}
}
