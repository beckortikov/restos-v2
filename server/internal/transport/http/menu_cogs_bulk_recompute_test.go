//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// POST /menu/recompute-cogs — разовый бэкфилл для блюда, у которого cogs был
// "заморожен" ДО того как автопересчёт появился: тех-карта заведена напрямую
// в БД (как при импорте старых данных), в обход API — значит триггеры
// TechCardsService.Create тут не срабатывали.
func TestCogs_BulkRecomputeBackfillsStaleValue(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	ingID := uuid.NewString()
	ingName, ingUnit := "Мука", "кг"
	if err := gdb.Create(&models.Ingredient{
		ID: ingID, Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		PricePerUnit: decimal.MustFromString("20"),
	}).Error; err != nil {
		t.Fatal(err)
	}

	// Блюдо с "замороженной" себестоимостью 1 (старый импорт) и тех-картой в
	// обход API — как если бы данные попали напрямую в БД до автопересчёта.
	miID := uuid.NewString()
	miName := "Тесто"
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &miName, Price: decimal.MustFromString("30"),
		COGS: decimal.MustFromString("1"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	tcName, tcUnit := ingName, "г"
	if err := gdb.Create(&models.TechCardLine{
		ID: uuid.NewString(), MenuItemID: &miID, IngredientID: &ingID,
		Name: &tcName, Qty: decimal.MustFromString("500"), Unit: &tcUnit, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/menu/recompute-cogs", tok, uuid.NewString(), nil)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("recompute-cogs: %d %s", r.StatusCode, b)
	}
	var resp struct {
		Updated int64 `json:"updated"`
	}
	if err := json.Unmarshal(b, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Updated != 1 {
		t.Fatalf("updated = %d, want 1", resp.Updated)
	}

	var reloaded models.MenuItem
	if err := gdb.Where("id = ?", miID).First(&reloaded).Error; err != nil {
		t.Fatal(err)
	}
	if !decimal.Normalize(reloaded.COGS).Equal(decimal.MustFromString("10")) {
		t.Fatalf("после bulk-пересчёта cogs = %s, ожидали 10 (500г×20/кг)", decimal.Normalize(reloaded.COGS))
	}

	// Повторный вызов — блюдо уже актуально (значение не изменилось), updated=0.
	// "updated" считает именно ИЗМЕНИВШИЕСЯ блюда, а не все блюда с тех-картой.
	r, b = f.post(t, "/api/v1/menu/recompute-cogs", tok, uuid.NewString(), nil)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("recompute-cogs #2: %d %s", r.StatusCode, b)
	}
	resp.Updated = -1
	if err := json.Unmarshal(b, &resp); err != nil {
		t.Fatal(err)
	}
	if resp.Updated != 0 {
		t.Fatalf("второй вызов: updated = %d, want 0 (уже актуально)", resp.Updated)
	}
	if err := gdb.Where("id = ?", miID).First(&reloaded).Error; err != nil {
		t.Fatal(err)
	}
	if !decimal.Normalize(reloaded.COGS).Equal(decimal.MustFromString("10")) {
		t.Fatalf("после повторного пересчёта cogs = %s, ожидали те же 10", decimal.Normalize(reloaded.COGS))
	}
}
