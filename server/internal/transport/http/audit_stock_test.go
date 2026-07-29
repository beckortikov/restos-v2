//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Тесты аудита склада / себестоимости / полуфабрикатов.

// setIngPrice — задать цену и waste ингредиента.
func setIngProps(t *testing.T, gdb *gorm.DB, id string, price, wastePct string) {
	t.Helper()
	upd := map[string]any{"price_per_unit": decimal.MustFromString(price)}
	if wastePct != "" {
		upd["waste_percent"] = decimal.MustFromString(wastePct)
	}
	if err := gdb.Model(&models.Ingredient{}).Where("id = ?", id).Updates(upd).Error; err != nil {
		t.Fatal(err)
	}
}

// БАГ #18: waste_percent входит в COGS и в проверку остатка, но НЕ в списание.
// COGS «платит» за waste, а со склада уходит меньше → фантомный остаток.
func TestAudit_WastePercent_InDeductionMatchesCOGS(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Rice: цена 10, waste 20%. Тех-карта 0.2 кг/порция.
	var ing models.Ingredient
	gdb.Where("restaurant_id = ? AND name = ?", f.rid, "Rice").First(&ing)
	setIngProps(t, gdb, ing.ID, "10", "20")
	startQty := ingQty(t, gdb, ing.ID)

	orderID := auditCreateOrder(t, f, tok, menuItemID, "1")
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}

	deducted := decimal.Sub(startQty, ingQty(t, gdb, ing.ID)) // сколько реально ушло

	// COGS позиции.
	var item models.OrderItem
	if err := gdb.Where("order_id = ?", orderID).First(&item).Error; err != nil {
		t.Fatal(err)
	}
	// Кол-во, за которое «заплатил» COGS = cogs / price.
	cogsQty := decimal.DivRound(item.COGS, decimal.MustFromString("10"))

	// Списанное со склада обязано совпасть с тем, за что списан COGS.
	if !deducted.Equal(cogsQty) {
		t.Errorf("со склада ушло %s, COGS оплатил %s — waste учтён в COGS/проверке, но не в списании (фантом %s)",
			deducted, cogsQty, decimal.Sub(cogsQty, deducted))
	}
}

// БАГ #20: тех-карта в «г» при складе в «шт» без unit_weight → тихий фолбэк
// списывает голое число рецепта в чужой единице.
func TestAudit_UnitsFallback_NoWildDeduction(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, shiftID, accountID := seedForWrite(t, f)

	// Ингредиент в штуках, без unit_weight, остаток 50 шт.
	unit := "шт"
	iname := "Булочка"
	ing := &models.Ingredient{
		ID: uuid.NewString(), Name: &iname, Unit: &unit,
		Qty: decimal.MustFromString("50"), PricePerUnit: decimal.MustFromString("3"),
		RestaurantID: &f.rid,
	}
	if err := gdb.Create(ing).Error; err != nil {
		t.Fatal(err)
	}
	// Блюдо с тех-картой «200 г» этого ингредиента.
	dname := "Блюдо-г"
	price := decimal.MustFromString("40")
	station := "hot_kitchen"
	mi := &models.MenuItem{ID: uuid.NewString(), Name: &dname, Price: price, Station: &station, RestaurantID: &f.rid}
	if err := gdb.Create(mi).Error; err != nil {
		t.Fatal(err)
	}
	gunit := "g"
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &mi.ID, IngredientID: &ing.ID, Name: &iname,
		Qty: decimal.MustFromString("200"), Unit: &gunit, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	startQty := ingQty(t, gdb, ing.ID)

	orderID := auditCreateOrder(t, f, tok, mi.ID, "1")
	if r, b := f.post(t, "/api/v1/orders/"+orderID+"/close", tok, uuid.NewString(), map[string]any{
		"payment_method": "cash", "account_id": accountID, "shift_id": shiftID,
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("close: %d %s", r.StatusCode, b)
	}
	deducted := decimal.Sub(startQty, ingQty(t, gdb, ing.ID))
	// Списание «200 штук» за одну порцию — заведомая аномалия.
	if deducted.GreaterThanOrEqual(decimal.MustFromString("200")) {
		t.Errorf("списано %s шт за 1 порцию — тихий фолбэк единиц (200 г → 200 шт)", deducted)
	}
}

// БАГ #21: списание semi через GREATEST(0,…) снимает только остаток, но
// стоимость/qty строки записываются на полный запрошенный объём.
func TestAudit_WriteoffSemi_CostMatchesRemoved(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Полуфабрикат: остаток 2 ед., цена 50.
	sname := "Бульон"
	sunit := "l"
	semi := &models.SemiFinishedStock{
		ID: uuid.NewString(), Name: &sname, Unit: &sunit,
		Qty: decimal.MustFromString("2"), PricePerUnit: decimal.MustFromString("50"),
		RestaurantID: &f.rid,
	}
	if err := gdb.Create(semi).Error; err != nil {
		t.Fatal(err)
	}

	// Списываем 5 (больше остатка), cost за 5 = 250.
	r, b := f.post(t, "/api/v1/stock/writeoffs", tok, uuid.NewString(), map[string]any{
		"reason": "spoilage",
		"lines": []map[string]any{{
			"ingredient_id": semi.ID, "name": sname, "qty": "5", "unit": sunit, "cost": "250", "kind": "semi",
		}},
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("writeoff: %d %s", r.StatusCode, b)
	}

	// Физически снято 2 (остаток обнулился).
	var after models.SemiFinishedStock
	gdb.First(&after, "id = ?", semi.ID)
	if !after.Qty.IsZero() {
		t.Fatalf("предусловие: остаток п/ф = %s, want 0", after.Qty)
	}

	// Стоимость списания обязана быть за реально снятые 2 (=100), а не за 5 (=250).
	var wl []models.StockWriteoffLine
	gdb.Where("ingredient_id = ?", semi.ID).Find(&wl)
	var recordedQty decimal.Decimal
	for _, l := range wl {
		recordedQty = decimal.Add(recordedQty, l.Qty)
	}
	if recordedQty.GreaterThan(decimal.MustFromString("2")) {
		t.Errorf("строка списания записала qty=%s, снято физически 2 — фантомные %s ед. в стоимостных книгах",
			recordedQty, decimal.Sub(recordedQty, decimal.MustFromString("2")))
	}
}

// БАГ #22: инвентаризация Apply не фиксирует стоимость недостачи — убыток
// исчезает из учёта, только тихо падает оценка склада.
func TestAudit_InventoryShortfall_RecordsLoss(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	var ing models.Ingredient
	gdb.Where("restaurant_id = ? AND name = ?", f.rid, "Rice").First(&ing)
	setIngProps(t, gdb, ing.ID, "10", "")

	// Инвентаризация: факт 4 при системных 10 → недостача 6 (стоимость 60).
	r, b := f.post(t, "/api/v1/stock/inventory", tok, uuid.NewString(), map[string]any{
		"lines": []map[string]any{{"ingredient_id": ing.ID, "actual_qty": "4"}},
	})
	if r.StatusCode != http.StatusCreated && r.StatusCode != http.StatusOK {
		t.Fatalf("inventory create: %d %s", r.StatusCode, b)
	}
	var chk models.InventoryCheck
	_ = json.Unmarshal(b, &chk)
	if r, b := f.post(t, "/api/v1/stock/inventory/"+chk.ID+"/apply", tok, uuid.NewString(), map[string]any{}); r.StatusCode != http.StatusOK {
		t.Fatalf("apply: %d %s", r.StatusCode, b)
	}

	// Склад упал до 4.
	if got := ingQty(t, gdb, ing.ID); !got.Equal(decimal.MustFromString("4")) {
		t.Fatalf("остаток после инвент = %s, want 4", got)
	}
	// Стоимость недостачи (60) обязана где-то зафиксироваться как убыток —
	// либо stock_writeoff, либо financial_operation. Иначе деньги «в никуда».
	var woCost decimal.Decimal
	var wos []models.StockWriteoff
	gdb.Where("restaurant_id = ?", f.rid).Find(&wos)
	for _, w := range wos {
		woCost = decimal.Add(woCost, w.TotalCost)
	}
	var finCnt int64
	gdb.Model(&models.FinancialOperation{}).
		Where("restaurant_id = ? AND category IN ?", f.rid, []string{"inventory_loss", "writeoff", "недостача"}).
		Count(&finCnt)
	if woCost.IsZero() && finCnt == 0 {
		t.Errorf("недостача 6 ед. (стоимость 60) не зафиксирована ни списанием, ни финоперацией — убыток исчез из учёта")
	}
}

// БАГ #24: semi Consume не пишет движение и не имеет пола — остаток уходит
// в минус без аудита.
func TestAudit_SemiConsume_MovementAndFloor(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Тип п/ф + остаток 2.
	stName := "Соус"
	st := &models.SemiFinishedType{ID: uuid.NewString(), Name: &stName, RestaurantID: &f.rid}
	if err := gdb.Create(st).Error; err != nil {
		t.Fatal(err)
	}
	sunit := "l"
	semi := &models.SemiFinishedStock{
		ID: uuid.NewString(), SemiTypeID: &st.ID, Name: &stName, Unit: &sunit,
		Qty: decimal.MustFromString("2"), PricePerUnit: decimal.MustFromString("30"), RestaurantID: &f.rid,
	}
	if err := gdb.Create(semi).Error; err != nil {
		t.Fatal(err)
	}

	// Потребляем 5 при остатке 2.
	r, b := f.post(t, "/api/v1/semi/consume", tok, uuid.NewString(), map[string]any{
		"semi_type_id": st.ID, "qty": "5",
	})
	if r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Skipf("consume: %d %s", r.StatusCode, b)
	}

	var after models.SemiFinishedStock
	gdb.First(&after, "id = ?", semi.ID)
	// Остаток не должен уходить в минус без контроля.
	if decimal.IsNegative(after.Qty) {
		t.Errorf("остаток п/ф = %s — Consume ушёл в минус без пола и без аудит-движения", after.Qty)
	}
}

// БАГ #19: yield_percent применяется в каскаде продажи, но НЕ в производстве
// (Prepare). Один и тот же п/ф снимает разное сырьё двумя путями.
func TestAudit_SemiPrepare_AppliesYield(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Сырьё: 100 кг @ 10.
	raw := seedReturnIngredient(t, gdb, f.rid, "Сырьё-п/ф", "kg")
	if err := gdb.Model(&models.Ingredient{}).Where("id = ?", raw.ID).
		Updates(map[string]any{"qty": decimal.MustFromString("100"), "price_per_unit": decimal.MustFromString("10")}).Error; err != nil {
		t.Fatal(err)
	}
	// Тип п/ф: yield 70%, рецепт 1 кг сырья на единицу выхода.
	yield := decimal.MustFromString("70")
	stName := "Фарш"
	st := &models.SemiFinishedType{ID: uuid.NewString(), Name: &stName, YieldPercent: yield, RestaurantID: &f.rid}
	if err := gdb.Create(st).Error; err != nil {
		t.Fatal(err)
	}
	rkg := "kg"
	if err := gdb.Create(&models.SemiRecipeLine{
		ID: uuid.NewString(), SemiTypeID: &st.ID, IngredientID: &raw.ID, Name: &stName,
		QtyPerUnit: decimal.MustFromString("1"), Unit: &rkg,
	}).Error; err != nil {
		t.Fatal(err)
	}

	startRaw := ingQty(t, gdb, raw.ID)
	// Производим 7 единиц выхода.
	if r, b := f.post(t, "/api/v1/semi/prepare", tok, uuid.NewString(), map[string]any{
		"semi_type_id": st.ID, "qty": "7",
	}); r.StatusCode != http.StatusOK && r.StatusCode != http.StatusCreated {
		t.Skipf("prepare: %d %s", r.StatusCode, b)
	}
	deducted := decimal.Sub(startRaw, ingQty(t, gdb, raw.ID))

	// При yield 70% на 7 единиц выхода нужно 7/0.7 = 10 кг сырья — так же, как
	// считает каскад продажи (×100/yield). Prepare же снимает ровно 7 (без yield).
	if deducted.Equal(decimal.MustFromString("7")) {
		t.Errorf("Prepare снял %s кг сырья на 7 единиц выхода — yield 70%% проигнорирован "+
			"(каскад продажи снял бы 10). Себестоимость п/ф занижена, COGS блюд занижен", deducted)
	}
}
