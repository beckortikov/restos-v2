//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Полный write-flow: login → POST /orders → POST /orders/{id}/items → POST /orders/{id}/close.
// Проверяем побочные эффекты: financial_operations, stock_movements, shift aggregates, audit_log, idempotency.

func (f *e2eFixture) post(t *testing.T, path, token, idemKey string, body any) (*http.Response, []byte) {
	t.Helper()
	var bodyBuf []byte
	if body != nil {
		bodyBuf, _ = json.Marshal(body)
	}
	req, _ := http.NewRequest("POST", f.srv.URL+path, bytes.NewReader(bodyBuf))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	b, _ := io.ReadAll(resp.Body)
	return resp, b
}

// seedForWrite доcтавляет фикстуру до состояния, пригодного для write-flow:
// добавляет ингредиент, tech_card_line, открытую смену, financial_account.
func seedForWrite(t *testing.T, f *e2eFixture) (gdb *gorm.DB, menuItemID, shiftID, accountID string) {
	gdb, _ = db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	// Берём существующий menu_item, созданный в setupE2E.
	var mi models.MenuItem
	if err := gdb.Where("restaurant_id = ?", f.rid).First(&mi).Error; err != nil {
		t.Fatal(err)
	}
	menuItemID = mi.ID

	// Ingredient.
	ingName := "Rice"
	ingUnit := "kg"
	ing := &models.Ingredient{
		ID: uuid.NewString(), Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("10"),
	}
	if err := gdb.Create(ing).Error; err != nil {
		t.Fatal(err)
	}
	// Tech card: 1 порция блюда = 0.2 кг Rice.
	tclName := ingName
	if err := gdb.Create(&models.TechCardLine{
		ID:           uuid.NewString(),
		MenuItemID:   &mi.ID,
		IngredientID: &ing.ID,
		Name:         &tclName,
		Qty:          decimal.MustFromString("0.2"),
		Unit:         &ingUnit,
		RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Open shift.
	openStatus := "open"
	shiftID = uuid.NewString()
	openedBy := "test"
	if err := gdb.Create(&models.CashShift{
		ID: shiftID, RestaurantID: &f.rid, Status: &openStatus,
		OpenedBy: &openedBy, OpeningBalance: decimal.MustFromString("0"),
		OpenedAt: time.Now().UTC(), UpdatedAt: time.Now().UTC(),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Financial account.
	accountID = uuid.NewString()
	accName := "Main cash"
	accType := "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: accountID, Name: &accName, Type: &accType, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return
}

func TestWrite_CreateAddClose(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// 1. POST /orders without Idempotency-Key → 400.
	resp, _ := f.post(t, "/api/v1/orders", tok, "", map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if resp.StatusCode != 400 {
		t.Fatalf("expected 400 without Idempotency-Key, got %d", resp.StatusCode)
	}

	// 2. POST /orders с двумя позициями по цене 25 → total = 50.
	idemCreate := uuid.NewString()
	resp, body := f.post(t, "/api/v1/orders", tok, idemCreate, map[string]any{
		"items": []map[string]any{
			{"menu_item_id": menuItemID, "qty": "1"},
			{"menu_item_id": menuItemID, "qty": "1"},
		},
	})
	if resp.StatusCode != 201 {
		t.Fatalf("create %d: %s", resp.StatusCode, body)
	}
	var created models.Order
	_ = json.Unmarshal(body, &created)
	if !created.Total.Equal(decimal.MustFromString("50")) {
		t.Errorf("total mismatch: %s", created.Total.String())
	}

	// 3. Повторный POST с тем же Idempotency-Key → тот же ответ из кэша.
	resp2, body2 := f.post(t, "/api/v1/orders", tok, idemCreate, map[string]any{
		"items": []map[string]any{
			{"menu_item_id": menuItemID, "qty": "1"},
			{"menu_item_id": menuItemID, "qty": "1"},
		},
	})
	if resp2.StatusCode != 201 {
		t.Fatalf("replay status %d", resp2.StatusCode)
	}
	if string(body) != string(body2) {
		t.Errorf("replay body diverges:\n  first:  %q\n  second: %q", body, body2)
	}
	if resp2.Header.Get("X-Idempotent-Replay") != "true" {
		t.Errorf("expected X-Idempotent-Replay header")
	}

	// 4. Конфликт: тот же ключ, другое тело.
	resp3, _ := f.post(t, "/api/v1/orders", tok, idemCreate, map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "5"}},
	})
	if resp3.StatusCode != 409 {
		t.Errorf("expected 409 on body mismatch, got %d", resp3.StatusCode)
	}

	// 5. AddItems: +1 позиция.
	addPath := fmt.Sprintf("/api/v1/orders/%s/items", created.ID)
	resp4, body4 := f.post(t, addPath, tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}},
	})
	if resp4.StatusCode != 200 {
		t.Fatalf("add %d: %s", resp4.StatusCode, body4)
	}
	var updated models.Order
	_ = json.Unmarshal(body4, &updated)
	if !updated.Total.Equal(decimal.MustFromString("75")) {
		t.Errorf("after add total = %s, want 75", updated.Total.String())
	}

	// 6. Close.
	closePath := fmt.Sprintf("/api/v1/orders/%s/close", created.ID)
	resp5, body5 := f.post(t, closePath, tok, uuid.NewString(), map[string]any{
		"payment_method": "cash",
		"account_id":     accountID,
		"shift_id":       shiftID,
		"tip_amount":     "5",
	})
	if resp5.StatusCode != 200 {
		t.Fatalf("close %d: %s", resp5.StatusCode, body5)
	}
	var closed models.Order
	_ = json.Unmarshal(body5, &closed)
	if closed.Status == nil || *closed.Status != "closed" {
		t.Errorf("status not closed: %v", closed.Status)
	}
	if !closed.TotalWithService.Equal(decimal.MustFromString("80")) {
		t.Errorf("total_with_service = %s, want 80 (75+tip 5)", closed.TotalWithService.String())
	}

	// 7. Проверяем побочные эффекты в БД.
	var finOps []models.FinancialOperation
	if err := gdb.Where("source_ref = ?", "order:"+created.ID).Find(&finOps).Error; err != nil {
		t.Fatal(err)
	}
	if len(finOps) != 1 {
		t.Errorf("want 1 finop, got %d", len(finOps))
	}
	if len(finOps) == 1 && !finOps[0].Amount.Equal(decimal.MustFromString("80")) {
		t.Errorf("finop amount = %s, want 80", finOps[0].Amount.String())
	}

	var movements []models.StockMovement
	if err := gdb.Where("description = ?", "order:"+created.ID).Find(&movements).Error; err != nil {
		t.Fatal(err)
	}
	// 3 порции × 1 tech_card_line = 3 движения, каждое 0.2 кг
	if len(movements) != 3 {
		t.Errorf("want 3 stock movements, got %d", len(movements))
	}
	for _, m := range movements {
		if !m.Qty.Equal(decimal.MustFromString("-0.2")) {
			t.Errorf("movement qty = %s, want -0.2", m.Qty.String())
		}
	}

	// shift aggregates: 1 заказ, cash_revenue = 80, avg_check = 80.
	var shift models.CashShift
	if err := gdb.First(&shift, "id = ?", shiftID).Error; err != nil {
		t.Fatal(err)
	}
	if shift.OrdersCount == nil || *shift.OrdersCount != 1 {
		t.Errorf("orders_count = %v, want 1", shift.OrdersCount)
	}
	if !shift.CashRevenue.Equal(decimal.MustFromString("80")) {
		t.Errorf("cash_revenue = %s, want 80", shift.CashRevenue.String())
	}

	// Двойной close → CONFLICT.
	resp6, _ := f.post(t, closePath, tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	})
	if resp6.StatusCode != 409 {
		t.Errorf("double close expected 409, got %d", resp6.StatusCode)
	}

	// audit_log должен содержать запись о Create / Update / etc.
	var auditCount int64
	if err := gdb.Model(&models.AuditLog{}).
		Where("entity_id = ?", created.ID).
		Count(&auditCount).Error; err != nil {
		t.Fatal(err)
	}
	if auditCount == 0 {
		t.Errorf("audit_log empty for order %s", created.ID)
	}
}
