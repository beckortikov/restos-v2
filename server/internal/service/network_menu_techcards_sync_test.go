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

// TestNetworkMenuTechCardsPropagation — техкарты мастера доезжают до филиала
// (миграция 085): правка строки на центре пересобирает снапшот; филиал
// материализует строки, создавая ингредиенты через номенклатуру и
// полуфабрикаты с рецептом, пересчитывает себестоимость; повторные pull'ы
// ничего не плодят; правка количества доезжает; мастер без tech_cards не
// трогает техкарты, заведённые филиалом самостоятельно.
func TestNetworkMenuTechCardsPropagation(t *testing.T) {
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
		"tech_card_lines", "semi_recipe_lines", "semi_finished_types",
		"menu_item_variant_values", "menu_attribute_values", "menu_attributes",
		"size_scale_values", "size_scales", "menu_items", "network_menu_items",
		"nomenclature", "ingredients", "warehouses", "restaurants",
		"company_accounts", "sync_log",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	// ─── Центр: мастер с размерами + локальный продукт, привязанный к нему ──
	masterID := uuid.NewString()
	name, cat, hot := "Пепперони", "Пиццы", "hot_kitchen"
	attrs := `{"attributes":[{"name":"Размер","scale":true,"values":["M","L"]}],
	           "combos":[{"labels":["M"],"price":"46"},{"labels":["L"],"price":"55"}]}`
	gdb.Create(&models.NetworkMenuItem{
		ID: masterID, AccountID: &accountID, Name: name, Category: &cat,
		BasePrice: decimal.Zero, Station: &hot, Attributes: datatypes.JSON(attrs),
	})
	productID := uuid.NewString()
	avail := true
	gdb.Create(&models.MenuItem{
		ID: productID, Name: &name, Category: &cat, MasterID: &masterID,
		RestaurantID: &centralID, Price: decimal.Zero, IsAvailable: &avail,
		UnitSize: decimal.MustFromString("1"), COGS: decimal.Zero,
	})

	ctxCentral := tenant.WithRestaurant(context.Background(), centralID)
	menuSvc := service.NewMenuService(repo.New(gdb))
	priceM, priceL := "46", "55"
	state, err := menuSvc.SyncAttributes(ctxCentral, productID, service.SyncAttributesInput{
		Attributes: []service.MenuAttributeInput{{Name: "Размер", Values: []service.MenuAttributeValueInput{{Label: "M"}, {Label: "L"}}}},
		Combos: []service.ComboPriceInput{
			{Labels: []string{"M"}, Price: &priceM},
			{Labels: []string{"L"}, Price: &priceL},
		},
	})
	if err != nil {
		t.Fatalf("варианты центра: %v", err)
	}
	var variantM string
	for _, v := range state.Variants {
		if *v.Name == "Пепперони M" {
			variantM = v.ID
		}
	}
	if variantM == "" {
		t.Fatal("вариант M не создан")
	}

	// Ингредиенты центра: «Сыр» БЕЗ привязки к номенклатуре (должен
	// каталогизироваться сам), «Мука» — для рецепта теста.
	cheese, flour, kg := "Сыр", "Мука", "кг"
	cheeseID, flourID := uuid.NewString(), uuid.NewString()
	gdb.Create(&models.Ingredient{ID: cheeseID, Name: &cheese, Unit: &kg, Qty: decimal.MustFromString("10"),
		PricePerUnit: decimal.MustFromString("120"), RestaurantID: &centralID})
	gdb.Create(&models.Ingredient{ID: flourID, Name: &flour, Unit: &kg, Qty: decimal.MustFromString("50"),
		PricePerUnit: decimal.MustFromString("8"), RestaurantID: &centralID})

	// Полуфабрикат «Тесто» размера M (шкалу центра создала материализация?
	// нет — центр сам вёл вариации; заводим шкалу руками, как сделала бы форма).
	scaleID, valueMID := uuid.NewString(), uuid.NewString()
	gdb.Create(&models.SizeScale{ID: scaleID, Name: "Размер", RestaurantID: &centralID})
	gdb.Create(&models.SizeScaleValue{ID: valueMID, SizeScaleID: scaleID, Code: "M", SortOrder: 0, RestaurantID: &centralID})
	dough := "Тесто"
	doughID := uuid.NewString()
	gdb.Create(&models.SemiFinishedType{ID: doughID, Name: &dough, OutputUnit: &kg,
		YieldPercent: decimal.MustFromString("100"), SizeScaleValueID: &valueMID, RestaurantID: &centralID})
	gdb.Create(&models.SemiRecipeLine{ID: uuid.NewString(), SemiTypeID: &doughID, IngredientID: &flourID,
		Name: &flour, QtyPerBatch: decimal.MustFromString("0.5"), Unit: &kg})

	// ─── Правки техкарты на центре → снапшот пересобирается сам ─────────────
	techSvc := service.NewTechCardsService(repo.New(gdb))
	qtyCheese, qtyDough := "0.1", "1"
	if _, err := techSvc.Create(ctxCentral, service.TechCardLineInput{
		MenuItemID: &variantM, IngredientID: &cheeseID, Name: &cheese, Qty: &qtyCheese, Unit: &kg,
	}); err != nil {
		t.Fatalf("строка сыра: %v", err)
	}
	if _, err := techSvc.Create(ctxCentral, service.TechCardLineInput{
		MenuItemID: &variantM, SemiTypeID: &doughID, Name: &dough, Qty: &qtyDough, Unit: &kg,
	}); err != nil {
		t.Fatalf("строка теста: %v", err)
	}

	var master models.NetworkMenuItem
	gdb.First(&master, "id = ?", masterID)
	if len(master.TechCards) == 0 {
		t.Fatal("снапшот техкарт мастера не собрался после правки строки")
	}
	var nomCheese models.Nomenclature
	if err := gdb.Where("name = ?", cheese).First(&nomCheese).Error; err != nil {
		t.Fatal("«Сыр» не каталогизировался при сборке снапшота")
	}
	var centralCheese models.Ingredient
	gdb.First(&centralCheese, "id = ?", cheeseID)
	if centralCheese.NomenclatureID == nil || *centralCheese.NomenclatureID != nomCheese.ID {
		t.Error("ингредиент центра не привязан к созданной номенклатуре")
	}

	// ─── Доставка на филиал ────────────────────────────────────────────────
	syncSvc := service.NewSyncService(repo.New(gdb))
	deliver := func() {
		t.Helper()
		pull, err := syncSvc.PullFor(context.Background(), branchID, nil)
		if err != nil {
			t.Fatal(err)
		}
		if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
			t.Fatal(err)
		}
	}
	deliver()

	var bProduct models.MenuItem
	if err := gdb.Where("restaurant_id = ? AND master_id = ?", branchID, masterID).First(&bProduct).Error; err != nil {
		t.Fatalf("продукт филиала: %v", err)
	}
	var bVariantM models.MenuItem
	if err := gdb.Where("restaurant_id = ? AND parent_id = ? AND name = ?", branchID, bProduct.ID, "Пепперони M").
		First(&bVariantM).Error; err != nil {
		t.Fatalf("вариант M филиала: %v", err)
	}
	var bLines []models.TechCardLine
	gdb.Where("restaurant_id = ? AND menu_item_id = ?", branchID, bVariantM.ID).Find(&bLines)
	if len(bLines) != 2 {
		t.Fatalf("строк техкарты у филиала = %d, want 2", len(bLines))
	}
	var bCheese models.Ingredient
	if err := gdb.Where("restaurant_id = ? AND nomenclature_id = ?", branchID, nomCheese.ID).
		First(&bCheese).Error; err != nil {
		t.Fatal("«Сыр» филиала не создан через номенклатуру")
	}
	var bDough models.SemiFinishedType
	if err := gdb.Where("restaurant_id = ? AND name = ?", branchID, dough).First(&bDough).Error; err != nil {
		t.Fatal("«Тесто» филиала не создано")
	}
	if bDough.SizeScaleValueID == nil {
		t.Error("«Тесто» филиала без тега размера — техкарта не подскажет заготовку под размер")
	}
	var bRecipe []models.SemiRecipeLine
	gdb.Where("semi_type_id = ?", bDough.ID).Find(&bRecipe)
	if len(bRecipe) != 1 {
		t.Errorf("рецепт «Теста» филиала: %d строк, want 1", len(bRecipe))
	}
	gdb.First(&bVariantM, "id = ?", bVariantM.ID)
	if !bVariantM.COGS.IsPositive() {
		t.Errorf("себестоимость варианта филиала не пересчитана: %s", bVariantM.COGS.String())
	}

	// ─── Идемпотентность повторов ──────────────────────────────────────────
	gdb.Exec("DELETE FROM sync_log")
	for i := 0; i < 3; i++ {
		deliver()
	}
	var lineCount, semiCount, deltas int64
	gdb.Model(&models.TechCardLine{}).Where("restaurant_id = ? AND menu_item_id = ?", branchID, bVariantM.ID).Count(&lineCount)
	gdb.Model(&models.SemiFinishedType{}).Where("restaurant_id = ?", branchID).Count(&semiCount)
	gdb.Model(&models.SyncLog{}).Count(&deltas)
	if lineCount != 2 || semiCount != 1 {
		t.Errorf("повторы наплодили: строк %d (want 2), полуфабрикатов %d (want 1)", lineCount, semiCount)
	}
	if deltas != 0 {
		t.Errorf("повторные pull'ы пишут %d дельт — бесконечный пересинк", deltas)
	}

	// ─── Правка на центре доезжает ─────────────────────────────────────────
	var centralLine models.TechCardLine
	gdb.Where("restaurant_id = ? AND menu_item_id = ? AND ingredient_id = ?", centralID, variantM, cheeseID).
		First(&centralLine)
	newQty := "0.2"
	if _, err := techSvc.Patch(ctxCentral, centralLine.ID, service.TechCardLineInput{Qty: &newQty}); err != nil {
		t.Fatalf("правка количества: %v", err)
	}
	deliver()
	var bCheeseLine models.TechCardLine
	gdb.Where("restaurant_id = ? AND menu_item_id = ? AND ingredient_id = ?", branchID, bVariantM.ID, bCheese.ID).
		First(&bCheeseLine)
	if !bCheeseLine.Qty.Equal(decimal.MustFromString("0.2")) {
		t.Errorf("новая граммовка не доехала: %s, want 0.2", bCheeseLine.Qty.String())
	}

	// ─── Мастер без tech_cards не трогает локальные техкарты филиала ───────
	flatID := uuid.NewString()
	tea, bar := "Чай", "bar"
	gdb.Create(&models.NetworkMenuItem{ID: flatID, AccountID: &accountID, Name: tea, BasePrice: decimal.MustFromString("5"), Station: &bar})
	deliver()
	var bTea models.MenuItem
	if err := gdb.Where("restaurant_id = ? AND master_id = ?", branchID, flatID).First(&bTea).Error; err != nil {
		t.Fatalf("чай филиала: %v", err)
	}
	ctxBranch := tenant.WithRestaurant(context.Background(), branchID)
	ownQty := "0.01"
	if _, err := techSvc.Create(ctxBranch, service.TechCardLineInput{
		MenuItemID: &bTea.ID, IngredientID: &bCheese.ID, Name: &cheese, Qty: &ownQty, Unit: &kg,
	}); err != nil {
		t.Fatalf("своя строка филиала: %v", err)
	}
	deliver()
	var teaLines int64
	gdb.Model(&models.TechCardLine{}).Where("restaurant_id = ? AND menu_item_id = ?", branchID, bTea.ID).Count(&teaLines)
	if teaLines != 1 {
		t.Errorf("мастер без tech_cards затронул локальную техкарту: %d строк, want 1", teaLines)
	}
}
