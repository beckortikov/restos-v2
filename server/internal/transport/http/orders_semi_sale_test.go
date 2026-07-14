//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"gorm.io/gorm"
)

// C1 — списание заготовки при продаже по модели iiko:
//   - есть готовый остаток заготовки → расходуем его, сырьё НЕ трогаем;
//   - остатка нет → разузловываем в сырьё (cascade);
//   - остатка не хватает → берём что есть + разузловываем остаток.
//
// Фикстура: блюдо «Soup» = 0.5 L заготовки «Broth»; рецепт Broth = 2 kg «Meat» на 1 L.

// seedSemiSoup создаёт Meat(100kg) + Broth(semi, yield 100%) + рецепт(2kg/L) +
// блюдо Soup с тех-картой из 0.5 L Broth. Возвращает id блюда, id заготовки и Meat.
func seedSemiSoup(t *testing.T, f *e2eFixture, gdb *gorm.DB) (soupID, semiID string, meat models.Ingredient) {
	t.Helper()
	meatName, meatUnit := "Meat", "kg"
	meat = models.Ingredient{
		ID: uuid.NewString(), Name: &meatName, Unit: &meatUnit, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("100"), PricePerUnit: decimal.MustFromString("400"),
	}
	if err := gdb.Create(&meat).Error; err != nil {
		t.Fatal(err)
	}
	semiName, semiUnit := "Broth", "L"
	semiID = uuid.NewString()
	if err := gdb.Create(&models.SemiFinishedType{
		ID: semiID, Name: &semiName, OutputUnit: &semiUnit, RestaurantID: &f.rid,
		YieldPercent: decimal.MustFromString("100"),
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.SemiRecipeLine{
		ID: uuid.NewString(), SemiTypeID: &semiID, IngredientID: &meat.ID,
		Name: &meatName, QtyPerUnit: decimal.MustFromString("2"), Unit: &meatUnit,
	}).Error; err != nil {
		t.Fatal(err)
	}
	soupName, soupCat := "Soup", "Kitchen"
	soupID = uuid.NewString()
	if err := gdb.Create(&models.MenuItem{
		ID: soupID, Name: &soupName, Category: &soupCat, Price: decimal.MustFromString("30"),
		RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	brothUnit := "L"
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &soupID, SemiTypeID: &semiID,
		Name: &semiName, Qty: decimal.MustFromString("0.5"), Unit: &brothUnit, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return
}

// sellOneSoup создаёт заказ на 1 Soup и закрывает его (списание склада проходит на close).
func sellOneSoup(t *testing.T, f *e2eFixture, tok, soupID, shiftID, accountID string) {
	t.Helper()
	r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(), map[string]any{
		"items": []map[string]any{{"menu_item_id": soupID, "qty": "1"}},
	})
	if r.StatusCode != 201 {
		t.Fatalf("create order: %d %s", r.StatusCode, b)
	}
	var ord models.Order
	_ = json.Unmarshal(b, &ord)
	rc, bc := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	})
	if rc.StatusCode != 200 {
		t.Fatalf("close order: %d %s", rc.StatusCode, bc)
	}
}

func semiStockQty(t *testing.T, gdb *gorm.DB, rid, semiID string) decimal.Decimal {
	t.Helper()
	var st models.SemiFinishedStock
	if err := gdb.Where("restaurant_id = ? AND semi_type_id = ?", rid, semiID).First(&st).Error; err != nil {
		return decimal.Zero
	}
	return st.Qty
}

func ingQty(t *testing.T, gdb *gorm.DB, id string) decimal.Decimal {
	t.Helper()
	var i models.Ingredient
	if err := gdb.Where("id = ?", id).First(&i).Error; err != nil {
		t.Fatal(err)
	}
	return i.Qty
}

// Сценарий 1: заготовка произведена → продажа расходует остаток заготовки,
// сырьё НЕ списывается повторно (это и есть фикс двойного списания).
func TestSemiSale_WithStock_ConsumesSemi_NotRaw(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	soupID, semiID, meat := seedSemiSoup(t, f, gdb)

	// Prepare 5 L broth → Meat -= 5*2 = 10 kg (100 → 90).
	r, b := f.post(t, "/api/v1/semi/prepare", tok, uuid.NewString(), map[string]any{"semi_type_id": semiID, "qty": "5"})
	if r.StatusCode != 200 {
		t.Fatalf("prepare: %d %s", r.StatusCode, b)
	}
	meatAfterPrep := ingQty(t, gdb, meat.ID)
	if !meatAfterPrep.Equal(decimal.MustFromString("90")) {
		t.Fatalf("meat after prepare = %s, want 90", meatAfterPrep.String())
	}
	if got := semiStockQty(t, gdb, f.rid, semiID); !got.Equal(decimal.MustFromString("5")) {
		t.Fatalf("broth stock after prepare = %s, want 5", got.String())
	}

	sellOneSoup(t, f, tok, soupID, shiftID, accountID)

	// Заготовки: 5 - 0.5 = 4.5. Сырьё: без изменений (90) — НЕ списано повторно.
	if got := semiStockQty(t, gdb, f.rid, semiID); !got.Equal(decimal.MustFromString("4.5")) {
		t.Errorf("broth stock after sale = %s, want 4.5", got.String())
	}
	if got := ingQty(t, gdb, meat.ID); !got.Equal(meatAfterPrep) {
		t.Errorf("meat after sale = %s, want unchanged %s (двойное списание!)", got.String(), meatAfterPrep.String())
	}
}

// Сценарий 2: заготовки нет → продажа разузловывает в сырьё (cascade).
func TestSemiSale_NoStock_CascadesToRaw(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	soupID, semiID, meat := seedSemiSoup(t, f, gdb)

	sellOneSoup(t, f, tok, soupID, shiftID, accountID)

	// Нет остатка заготовки → cascade: 0.5 L / yield(1) × 2 kg/L = 1.0 kg Meat.
	if got := ingQty(t, gdb, meat.ID); !got.Equal(decimal.MustFromString("99")) {
		t.Errorf("meat after sale = %s, want 99 (100 − 1.0 cascade)", got.String())
	}
	if got := semiStockQty(t, gdb, f.rid, semiID); !got.Equal(decimal.Zero) {
		t.Errorf("broth stock = %s, want 0", got.String())
	}
}

// Сценарий 3: заготовки не хватает → расходуем что есть + разузловываем остаток.
func TestSemiSale_PartialStock_ConsumeThenCascade(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)
	soupID, semiID, meat := seedSemiSoup(t, f, gdb)

	// Prepare 0.3 L broth → Meat -= 0.3*2 = 0.6 (100 → 99.4). Нужно 0.5 L.
	r, b := f.post(t, "/api/v1/semi/prepare", tok, uuid.NewString(), map[string]any{"semi_type_id": semiID, "qty": "0.3"})
	if r.StatusCode != 200 {
		t.Fatalf("prepare: %d %s", r.StatusCode, b)
	}
	meatAfterPrep := ingQty(t, gdb, meat.ID)
	if !meatAfterPrep.Equal(decimal.MustFromString("99.4")) {
		t.Fatalf("meat after prepare = %s, want 99.4", meatAfterPrep.String())
	}

	sellOneSoup(t, f, tok, soupID, shiftID, accountID)

	// Заготовка вся ушла (0.3 → 0). Нехватка 0.2 L разузловывается: 0.2×2 = 0.4 kg.
	if got := semiStockQty(t, gdb, f.rid, semiID); !got.Equal(decimal.Zero) {
		t.Errorf("broth stock after sale = %s, want 0", got.String())
	}
	want := decimal.Normalize(decimal.Sub(meatAfterPrep, decimal.MustFromString("0.4")))
	if got := ingQty(t, gdb, meat.ID); !got.Equal(want) {
		t.Errorf("meat after sale = %s, want %s (99.4 − 0.4 cascade остатка)", got.String(), want.String())
	}
}
