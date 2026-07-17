//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// Матрица доступов на складе — авторитетно на сервере.
//
// Регрессия ревью 17.07.2026: складские write-роуты защищал ТОЛЬКО UI
// (canDo('inventory.manage')). Сервер спрашивал права лишь у заказов
// (orders_perms.go) — тот же класс дыры там уже находили и закрыли, а склад
// забыли. Доказано пробой: официант (нет inventory.manage в матрице) проводил
// возврат → 201 и уводил деньги со счёта, и сторно → 200.

// loginAs — токен произвольного пользователя ресторана по его PIN.
func loginAs(t *testing.T, f *e2eFixture, pin string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"restaurant_id": f.rid, "pin": pin})
	resp, err := http.Post(f.srv.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("login %d: %s", resp.StatusCode, b)
	}
	var out struct {
		Token string `json:"token"`
	}
	_ = json.Unmarshal(b, &out)
	return out.Token
}

// seedUserWithRole — пользователь БЕЗ индивидуальных прав: работают только
// дефолты роли (в отличие от фикстуры setupE2E, которой права выданы явно).
func seedUserWithRole(t *testing.T, gdb *gorm.DB, rid, role, pin string) {
	t.Helper()
	name := "Тест-" + role
	if err := gdb.Create(&models.User{
		ID: uuid.NewString(), Name: &name, PIN: &pin, Role: &role, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
}

// TestStockPerms_WaiterCannotTouchStock — официант не может ни принять товар,
// ни списать, ни вернуть, ни отменить возврат. Ключевой ассерт — деньги: возврат
// деньгами двигает баланс счёта, и до фикса официант мог это сделать.
func TestStockPerms_WaiterCannotTouchStock(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)
	ing := seedReturnIngredient(t, gdb, f.rid, "Товар-права", "kg")

	// Накладную создаём фикстурой (у неё права есть).
	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "supplier_name": "Ромашка", "account_id": accountID, "paid": true,
		"lines": []map[string]any{{
			"ingredient_id": ing.ID, "name": "Товар-права", "qty": "10", "unit": "kg", "price_per_unit": "10",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	var receipt models.StockReceipt
	if err := json.Unmarshal(b, &receipt); err != nil {
		t.Fatal(err)
	}
	lineID := receiptLineID(t, gdb, receipt.ID, ing.ID)

	seedUserWithRole(t, gdb, f.rid, "waiter", "4242")
	wtok := loginAs(t, f, "4242")

	var accBefore models.FinancialAccount
	gdb.First(&accBefore, "id = ?", accountID)

	// Возврат деньгами — двигает счёт. Официанту нельзя.
	if r, b := f.post(t, "/api/v1/stock/returns", wtok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "spoilage", "refund_type": "money", "account_id": accountID,
		"lines": []map[string]any{{"receipt_line_id": lineID, "qty": "10"}},
	}); r.StatusCode != http.StatusForbidden {
		t.Errorf("официант делает возврат: %d %s, want 403 (уводит деньги со счёта)", r.StatusCode, b)
	}
	var accAfter models.FinancialAccount
	gdb.First(&accAfter, "id = ?", accountID)
	if !accAfter.Balance.Equal(accBefore.Balance) {
		t.Errorf("баланс счёта изменился на отбитом возврате: %s → %s", accBefore.Balance, accAfter.Balance)
	}

	// Приёмка и списание — тоже нет.
	if r, _ := f.post(t, "/api/v1/stock/receipts", wtok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "supplier_name": "Ромашка",
		"lines": []map[string]any{{"ingredient_id": ing.ID, "name": "Товар-права", "qty": "1", "unit": "kg", "price_per_unit": "1"}},
	}); r.StatusCode != http.StatusForbidden {
		t.Errorf("официант делает приёмку: %d, want 403", r.StatusCode)
	}
	if r, _ := f.post(t, "/api/v1/stock/writeoffs", wtok, uuid.NewString(), map[string]any{
		"reason": "spoilage",
		"lines":  []map[string]any{{"ingredient_id": ing.ID, "name": "Товар-права", "qty": "1", "unit": "kg", "cost": "10"}},
	}); r.StatusCode != http.StatusForbidden {
		t.Errorf("официант делает списание: %d, want 403", r.StatusCode)
	}
	if r, _ := f.post(t, "/api/v1/suppliers/"+uuid.NewString()+"/pay-debt", wtok, uuid.NewString(),
		map[string]any{"amount": "10", "account_id": accountID}); r.StatusCode != http.StatusForbidden {
		t.Errorf("официант гасит долг поставщику: %d, want 403 (списывает деньги со счёта)", r.StatusCode)
	}
}

// TestStockPerms_CancelReturnGated — сторно двигает склад и деньги наравне с
// возвратом, поэтому закрыто тем же правом.
func TestStockPerms_CancelReturnGated(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, accountID := seedForWrite(t, f)
	topUp(t, gdb, accountID)
	ing := seedReturnIngredient(t, gdb, f.rid, "Товар-сторно-права", "kg")

	r, b := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(), map[string]any{
		"payment_type": "paid", "supplier_name": "Ромашка", "account_id": accountID, "paid": true,
		"lines": []map[string]any{{
			"ingredient_id": ing.ID, "name": "Товар-сторно-права", "qty": "10", "unit": "kg", "price_per_unit": "10",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("receipt: %d %s", r.StatusCode, b)
	}
	var receipt models.StockReceipt
	if err := json.Unmarshal(b, &receipt); err != nil {
		t.Fatal(err)
	}
	r, b = f.post(t, "/api/v1/stock/returns", tok, uuid.NewString(), map[string]any{
		"receipt_id": receipt.ID, "reason": "spoilage", "refund_type": "money", "account_id": accountID,
		"lines": []map[string]any{{"receipt_line_id": receiptLineID(t, gdb, receipt.ID, ing.ID), "qty": "5"}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("return: %d %s", r.StatusCode, b)
	}
	var ret models.StockReturn
	if err := json.Unmarshal(b, &ret); err != nil {
		t.Fatal(err)
	}

	seedUserWithRole(t, gdb, f.rid, "cook", "5151")
	ctok := loginAs(t, f, "5151")
	if r, b := f.post(t, "/api/v1/stock/returns/"+ret.ID+"/cancel", ctok, uuid.NewString(),
		map[string]any{}); r.StatusCode != http.StatusForbidden {
		t.Errorf("повар делает сторно: %d %s, want 403", r.StatusCode, b)
	}
	var after models.StockReturn
	gdb.First(&after, "id = ?", ret.ID)
	if after.CancelledAt != nil {
		t.Error("возврат отменён пользователем без прав")
	}

	// Кладовщик — можно: inventory.manage у него в матрице по умолчанию.
	seedUserWithRole(t, gdb, f.rid, "storekeeper", "6161")
	stok := loginAs(t, f, "6161")
	if r, b := f.post(t, "/api/v1/stock/returns/"+ret.ID+"/cancel", stok, uuid.NewString(),
		map[string]any{}); r.StatusCode != http.StatusOK {
		t.Errorf("кладовщик делает сторно: %d %s, want 200 (право есть по умолчанию)", r.StatusCode, b)
	}
}
