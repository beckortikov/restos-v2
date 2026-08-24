//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestNetworkMenuVariantsPropagation — вариации мастера доезжают до филиала
// (миграция 084): пицца с размерами материализуется как продукт + атрибут
// «Размер» со шкалой + варианты с ценами; повторный pull не плодит ничего;
// изменение цены комбинации на мастере доезжает; свои вариации филиала мастер
// без attributes не трогает.
func TestNetworkMenuVariantsPropagation(t *testing.T) {
	gdb, err := db.Open(transferTestDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	for _, tbl := range []string{
		"menu_item_variant_values", "menu_attribute_values", "menu_attributes",
		"size_scale_values", "size_scales", "menu_items", "network_menu_items",
		"restaurants", "company_accounts", "sync_log",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	branchID := uuid.NewString()
	ot := "outlet"
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	masterID := uuid.NewString()
	name, cat, hot := "Пепперони", "Пиццы", "hot_kitchen"
	attrs := `{"attributes":[{"name":"Размер","scale":true,"values":["Мини","M","L"]}],
	           "combos":[{"labels":["Мини"],"price":"25"},{"labels":["M"],"price":"46"},{"labels":["L"],"price":"55"}]}`
	gdb.Create(&models.NetworkMenuItem{
		ID: masterID, AccountID: &accountID, Name: name, Category: &cat,
		BasePrice: decimal.Zero, Station: &hot, Attributes: datatypes.JSON(attrs),
	})

	svc := service.NewSyncService(repo.New(gdb))
	menuSvc := service.NewMenuService(repo.New(gdb))
	ctx := context.Background()
	tctx := tenant.WithRestaurant(ctx, branchID)

	deliver := func() {
		t.Helper()
		pull, err := svc.PullFor(ctx, branchID, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := svc.ApplyPulled(ctx, *pull, branchID); err != nil {
			t.Fatal(err)
		}
	}
	deliver()

	// ─── Продукт + атрибут + варианты созданы ────────────────────────────
	var product models.MenuItem
	if err := gdb.Where("restaurant_id = ? AND master_id = ?", branchID, masterID).First(&product).Error; err != nil {
		t.Fatalf("продукт не материализован: %v", err)
	}
	state, err := menuSvc.GetAttributes(tctx, product.ID)
	if err != nil {
		t.Fatal(err)
	}
	if len(state.Attributes) != 1 || state.Attributes[0].Name != "Размер" {
		t.Fatalf("атрибут не создан: %+v", state.Attributes)
	}
	if len(state.Attributes[0].Values) != 3 {
		t.Fatalf("значений = %d, want 3", len(state.Attributes[0].Values))
	}
	if len(state.Variants) != 3 {
		t.Fatalf("вариантов = %d, want 3 — на POS пицца не даст выбрать размер", len(state.Variants))
	}
	priceByName := map[string]string{}
	for _, v := range state.Variants {
		priceByName[*v.Name] = decimal.Normalize(v.Price).String()
	}
	if priceByName["Пепперони Мини"] != "25" || priceByName["Пепперони M"] != "46" || priceByName["Пепперони L"] != "55" {
		t.Errorf("цены вариантов: %+v", priceByName)
	}

	// ─── Шкала размеров создана и привязана ──────────────────────────────
	if state.Attributes[0].SizeScaleID == nil {
		t.Error("атрибут не привязан к шкале — техкарты не подцепят заготовки по размеру")
	}
	var scale models.SizeScale
	if err := gdb.Where("restaurant_id = ? AND name = ?", branchID, "Размер").First(&scale).Error; err != nil {
		t.Errorf("шкала «Размер» не создана: %v", err)
	}

	// ─── Идемпотентность: повторные pull'ы ничего не плодят ──────────────
	gdb.Exec("DELETE FROM sync_log") // интересуемся только дельтами повторов
	for i := 0; i < 3; i++ {
		deliver()
	}
	var variantCount int64
	gdb.Model(&models.MenuItem{}).Where("parent_id = ?", product.ID).Count(&variantCount)
	if variantCount != 3 {
		t.Errorf("после повторов вариантов = %d, want 3", variantCount)
	}
	var deltas int64
	gdb.Model(&models.SyncLog{}).Count(&deltas)
	if deltas != 0 {
		t.Errorf("повторные pull'ы пишут %d дельт в sync_log — бесконечный пересинк", deltas)
	}

	// ─── Изменение мастера: новая цена комбинации доезжает ───────────────
	attrs2 := `{"attributes":[{"name":"Размер","scale":true,"values":["Мини","M","L"]}],
	            "combos":[{"labels":["Мини"],"price":"30"},{"labels":["M"],"price":"46"},{"labels":["L"],"price":"55"}]}`
	gdb.Model(&models.NetworkMenuItem{}).Where("id = ?", masterID).
		Update("attributes", datatypes.JSON(attrs2))
	deliver()
	state, err = menuSvc.GetAttributes(tctx, product.ID)
	if err != nil {
		t.Fatal(err)
	}
	for _, v := range state.Variants {
		if *v.Name == "Пепперони Мини" && !v.Price.Equal(decimal.MustFromString("30")) {
			t.Errorf("новая цена Мини не доехала: %s", v.Price.String())
		}
	}

	// ─── Мастер без attributes не трогает вариации филиала ───────────────
	flatID := uuid.NewString()
	tea := "Чай"
	gdb.Create(&models.NetworkMenuItem{ID: flatID, AccountID: &accountID, Name: tea, BasePrice: decimal.MustFromString("5"), Station: &hot})
	deliver()
	var teaItem models.MenuItem
	if err := gdb.Where("restaurant_id = ? AND master_id = ?", branchID, flatID).First(&teaItem).Error; err != nil {
		t.Fatalf("плоский мастер не материализован: %v", err)
	}
	// Филиал сам заводит чаю вариацию — мастер (attributes NULL) не должен снять её.
	if _, err := menuSvc.SyncAttributes(tctx, teaItem.ID, service.SyncAttributesInput{
		Attributes: []service.MenuAttributeInput{{Name: "Объём", Values: []service.MenuAttributeValueInput{{Label: "0,5л"}, {Label: "1л"}}}},
		Combos: []service.ComboPriceInput{
			{Labels: []string{"0,5л"}, Price: strPtr("5")},
			{Labels: []string{"1л"}, Price: strPtr("9")},
		},
	}); err != nil {
		t.Fatalf("локальные вариации: %v", err)
	}
	deliver()
	var teaVariants int64
	gdb.Model(&models.MenuItem{}).Where("parent_id = ? AND is_deleted = false", teaItem.ID).Count(&teaVariants)
	if teaVariants != 2 {
		t.Errorf("мастер без attributes снёс локальные вариации филиала: %d, want 2", teaVariants)
	}
}
