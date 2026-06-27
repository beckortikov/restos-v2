//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Диагностические тесты по жалобе пользователя:
//   A) продажа заготовочного блюда НЕ уменьшает prepared_qty (раздел
//      «Приготовление») и продажа не отражается в финансах (ДДС/ОПиУ/операции);
//   B) без открытой смены раньше был ристрикшн на продажу — проверить, держится ли.
//
// Запуск: go test -tags integration -run 'TestBatchSale|TestSale_' ./internal/transport/http/...

func dref(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

// TestBatchSale_PreparedQtyAndFinance — закрываем заказ с заготовочным блюдом
// при ОТКРЫТОЙ смене и счёте. Проверяем три вещи разом (t.Errorf, не Fatalf):
//  1. prepared_qty уменьшился на 1 (списание из готовой партии);
//  2. сырьё НЕ списалось повторно (ингредиенты уже ушли на produce);
//  3. создана revenue-финоперация (отражение в ДДС/ОПиУ/операциях).
func TestBatchSale_PreparedQtyAndFinance(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	// Счёт «Касса».
	accID := uuid.NewString()
	accName, accType := "Касса", "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Type: &accType, RestaurantID: &f.rid, Balance: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Открыть смену.
	r, b := f.post(t, "/api/v1/shifts", tok, uuid.NewString(),
		map[string]any{"opening_balance": "0", "account_id": accID})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("open shift %d: %s", r.StatusCode, b)
	}
	var shift models.CashShift
	_ = json.Unmarshal(b, &shift)

	// Заготовочное блюдо «Шашлык»: prepared_qty=5, цена 20, техкарта Гуш 300 г,
	// Гуш на складе 3 кг (состояние ПОСЛЕ produce — сырьё уже списано).
	menuID, ingID := seedBatchDishWithStock(t, gdb, f.rid, "Шашлык", 5, "3")

	// Создать заказ на 1 порцию.
	r, b = f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": menuID, "qty": "1"}}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order %d: %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)

	// Закрыть заказ (нал, счёт, смена).
	r, b = f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
		map[string]any{"payment_method": "cash", "account_id": accID, "shift_id": shift.ID})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("close order %d: %s", r.StatusCode, b)
	}

	// (1) prepared_qty должен стать 4.
	var mi models.MenuItem
	if err := gdb.Where("id = ?", menuID).First(&mi).Error; err != nil {
		t.Fatal(err)
	}
	if got := dref(mi.PreparedQty); got != 4 {
		t.Errorf("A1 prepared_qty: получили %d, ожидали 4 — продажа заготовки НЕ списывает готовую порцию", got)
	}

	// (2) Гуш не должен списаться повторно (остаётся 3 кг).
	var ing models.Ingredient
	if err := gdb.Where("id = ?", ingID).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.Qty.Equal(decimal.MustFromString("3")) {
		t.Errorf("A2 Гуш qty: получили %s, ожидали 3 — при продаже заготовки сырьё списывается ПОВТОРНО (и без конвертации единиц)",
			decimal.Normalize(ing.Qty).String())
	}

	// (3) revenue-финоперация должна существовать (ДДС/ОПиУ/операции).
	var finCount int64
	if err := gdb.Model(&models.FinancialOperation{}).
		Where("restaurant_id = ? AND source_ref = ? AND type = ? AND category = ?",
			f.rid, "order:"+ord.ID, "in", "revenue").
		Count(&finCount).Error; err != nil {
		t.Fatal(err)
	}
	if finCount != 1 {
		t.Errorf("A3 revenue financial_operation: получили %d, ожидали 1 — продажа не отражается в финансах", finCount)
	}

	// Доп. диагностика: видно ли в /finance/operations.
	or, ob := f.get(t, "/api/v1/finance/operations?limit=100", tok)
	if or.StatusCode == http.StatusOK {
		var env struct {
			Data []struct {
				Category *string `json:"category"`
				Type     *string `json:"type"`
			} `json:"data"`
		}
		_ = json.Unmarshal(ob, &env)
		seen := false
		for _, o := range env.Data {
			if o.Category != nil && *o.Category == "revenue" {
				seen = true
			}
		}
		if !seen {
			t.Errorf("A3 /finance/operations: revenue-операция не видна в списке операций")
		}
	}
}

// TestSale_RequiresOpenShift — Problem B: закрытие заказа БЕЗ shift_id должно
// отклоняться. Если проходит — ристрикшн «нет смены → нет продажи» сломан.
func TestSale_RequiresOpenShift(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	accID := uuid.NewString()
	accName, accType := "Касса", "cash"
	if err := gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Type: &accType, RestaurantID: &f.rid, Balance: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Заказ без смены.
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": seedSimpleDish(t, gdb, f.rid), "qty": "1"}}})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create order %d: %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)

	// Закрыть БЕЗ shift_id → ожидаем НЕ 200.
	r, b = f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
		map[string]any{"payment_method": "cash", "account_id": accID})
	if r.StatusCode == http.StatusOK {
		t.Errorf("B: закрытие без shift_id прошло (HTTP 200) — ристрикшн «нет открытой смены» НЕ работает на /close")
	}
}

func seedSimpleDish(t *testing.T, gdb *gorm.DB, rid string) string {
	t.Helper()
	id := uuid.NewString()
	name := "Кола"
	if err := gdb.Create(&models.MenuItem{
		ID: id, Name: &name, Price: decimal.MustFromString("10"), RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return id
}

// seedBatchDishWithStock — заготовка с prepared_qty + ингредиент (кг) и
// техкартой 300 г. Возвращает (menuID, ingID).
func seedBatchDishWithStock(t *testing.T, gdb *gorm.DB, rid, dish string, prepared int, ingKg string) (string, string) {
	t.Helper()
	ingID := uuid.NewString()
	ingName, ingUnit := "Гуш", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &rid,
		Qty: decimal.MustFromString(ingKg), MinQty: decimal.Zero,
	}).Error; err != nil {
		t.Fatal(err)
	}
	batch := true
	prep := prepared
	miID := uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &dish, Price: decimal.MustFromString("20"),
		IsBatchCooking: &batch, PreparedQty: &prep, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	tcl := ingName
	gram := "г"
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &miID, IngredientID: &ingID,
		Name: &tcl, Qty: decimal.MustFromString("300"), Unit: &gram, RestaurantID: &rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return miID, ingID
}
