//go:build integration

package service_test

import (
	"context"
	"encoding/json"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// TestNomenclaturePropagation — общий каталог номенклатуры сети (ADR-003,
// вариант 3B) распространяется на филиал через PullFor/ApplyPulled, тем же
// путём, что и мастер-меню (network_menu_sync_test.go). Регресс-пруф: раньше
// PullFor вообще не знал о nomenclature — товар, заведённый на central, никогда
// не попадал на филиал (найдено вживую: «рис» создан на central, не появился
// на филиале).
func TestNomenclaturePropagation(t *testing.T) {
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
	for _, tbl := range []string{"nomenclature", "restaurants", "company_accounts"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	branchID := uuid.NewString()
	ot := "outlet"
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	nomID := uuid.NewString()
	kg, cat := "kg", "Бакалея"
	if err := gdb.Create(&models.Nomenclature{ID: nomID, AccountID: &accountID, Name: "Рис", Unit: &kg, Category: &cat}).Error; err != nil {
		t.Fatal(err)
	}

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	// ─── PullFor отдаёт номенклатуру central целиком ──────────────────────
	pull, err := svc.PullFor(ctx, branchID, nil)
	if err != nil {
		t.Fatalf("PullFor: %v", err)
	}
	var found bool
	for _, e := range pull.Entries {
		if e.Entity == "nomenclature" && e.RowID == nomID {
			found = true
		}
	}
	if !found {
		t.Fatal("PullFor не вернул nomenclature — товар не дойдёт до филиала")
	}

	// ─── ApplyPulled применяет на филиале ──────────────────────────────────
	if _, err := svc.ApplyPulled(ctx, *pull, branchID); err != nil {
		t.Fatalf("ApplyPulled: %v", err)
	}
	var got models.Nomenclature
	if err := gdb.First(&got, "id = ?", nomID).Error; err != nil {
		t.Fatalf("nomenclature not applied: %v", err)
	}
	if got.Name != "Рис" || got.Unit == nil || *got.Unit != "kg" {
		t.Errorf("applied nomenclature = %+v, want Рис/kg", got)
	}

	// ─── Central переименовывает → повторный pull обновляет филиал ────────
	gdb.Model(&models.Nomenclature{}).Where("id = ?", nomID).Update("name", "Рис жасмин")
	pull2, err := svc.PullFor(ctx, branchID, nil)
	if err != nil {
		t.Fatalf("PullFor 2: %v", err)
	}
	if _, err := svc.ApplyPulled(ctx, *pull2, branchID); err != nil {
		t.Fatalf("ApplyPulled 2: %v", err)
	}
	var got2 models.Nomenclature
	gdb.First(&got2, "id = ?", nomID)
	if got2.Name != "Рис жасмин" {
		t.Errorf("name after rename = %q, want «Рис жасмин»", got2.Name)
	}

	// ─── Up-push: запись, заведённая ФИЛИАЛОМ, доезжает до central (Фаза Г) ──
	// Раньше central её отбрасывал (Skipped), и «общий» каталог тихо расходился:
	// у филиала-отправителя запись есть, у central нет, и тот же товар заводился
	// повторно с другим id. Приём на central пишет ТОЛЬКО строку каталога — свой
	// склад он товарами всех филиалов не засоряет (это проверяет счётчик ниже).
	gdb.Exec("DELETE FROM nomenclature WHERE id = ?", nomID)
	var ingBefore int64
	gdb.Model(&models.Ingredient{}).Count(&ingBefore)

	payload, _ := json.Marshal(got2)
	res, err := svc.Ingest(ctx, service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "nomenclature", RowID: nomID, Op: "upsert", Payload: payload},
	}}, "")
	if err != nil {
		t.Fatalf("Ingest: %v", err)
	}
	if res.Applied != 1 {
		t.Errorf("Ingest(nomenclature) applied=%d, want 1 — иначе каталог филиала не доедет до central", res.Applied)
	}
	var back models.Nomenclature
	if err := gdb.First(&back, "id = ?", nomID).Error; err != nil {
		t.Errorf("запись каталога не принята на central: %v", err)
	}
	var ingAfter int64
	gdb.Model(&models.Ingredient{}).Count(&ingAfter)
	if ingAfter != ingBefore {
		t.Errorf("приём на central завёл %d товаров — он не должен материализовать склад филиалов", ingAfter-ingBefore)
	}
}

// TestNomenclatureTombstoneUnlinks — Фаза Г: удаление записи из каталога сети
// доезжает до филиала и ОТВЯЗЫВАЕТ его товар, не трогая сам товар.
//
// Почему tombstone, а не обычный DELETE: down-sync — insert-if-absent, в нём
// исчезновение строки НЕОТЛИЧИМО от «её не прислали», поэтому удалённая запись
// жила бы у филиала вечно. И почему отвязывание, а не удаление товара: у него
// остаток и вся история движений — уборка справочника не повод их уничтожать.
func TestNomenclatureTombstoneUnlinks(t *testing.T) {
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
		"sync_log", "ingredients", "warehouses", "nomenclature", "restaurants", "company_accounts",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	nomID := uuid.NewString()
	kg := "кг"
	gdb.Create(&models.Nomenclature{ID: nomID, AccountID: &accountID, Name: "Рис", Unit: &kg})

	// Товар филиала с РЕАЛЬНЫМ остатком, привязанный к этой записи.
	riceName := "Рис"
	ingID := uuid.NewString()
	gdb.Create(&models.Ingredient{
		ID: ingID, Name: &riceName, Unit: &kg, Qty: decimal.MustFromString("42"),
		PricePerUnit: decimal.MustFromString("11"), RestaurantID: &branchID, NomenclatureID: &nomID,
	})

	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	netSvc := service.NewNetworkService(repo.New(gdb), "")
	syncSvc := service.NewSyncService(repo.New(gdb))
	owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), owner)

	// ─── Создание через сервис при ВКЛЮЧЁННОМ синке ───────────────────────
	// Отдельная проверка, потому что именно этот путь однажды был сломан молча:
	// recordNomenclatureSync писал op="upsert", которого нет в CHECK-constraint
	// sync_log (insert|update|delete) — и создание записи каталога на филиале с
	// включённой синхронизацией роняло всю транзакцию. В тестах ветка не
	// исполнялась, потому что фикстуры создавали строки напрямую.
	created, err := netSvc.CreateNomenclature(ctxCentral, service.CreateNomenclatureInput{
		Name: "Сахар", Unit: &kg,
	})
	if err != nil {
		t.Fatalf("CreateNomenclature при включённом синке: %v", err)
	}
	var createdLog int64
	gdb.Model(&models.SyncLog{}).
		Where("table_name = ? AND row_id = ?", "nomenclature", created.ID).Count(&createdLog)
	if createdLog == 0 {
		t.Error("создание записи каталога не попало в sync_log — central о ней не узнает")
	}

	// ─── Удаление на центре ───────────────────────────────────────────────
	if err := netSvc.DeleteNomenclature(ctxCentral, nomID); err != nil {
		t.Fatalf("DeleteNomenclature: %v", err)
	}
	// Из живого каталога пропала...
	live, err := netSvc.ListNomenclature(ctxCentral)
	if err != nil {
		t.Fatal(err)
	}
	for _, n := range live {
		if n.ID == nomID {
			t.Error("удалённая запись всё ещё в каталоге")
		}
	}
	// ...но строка НЕ стёрта — иначе филиалу нечего было бы прислать.
	var stone models.Nomenclature
	if err := gdb.First(&stone, "id = ?", nomID).Error; err != nil {
		t.Fatalf("строка удалена физически — tombstone не доедет: %v", err)
	}
	if stone.DeletedAt == nil {
		t.Error("deleted_at не проставлен")
	}
	// Повторное удаление — честный 404.
	if err := netSvc.DeleteNomenclature(ctxCentral, nomID); err == nil {
		t.Error("повторное удаление должно вернуть NOT_FOUND")
	}

	// ─── Tombstone доезжает до филиала ────────────────────────────────────
	pull, err := syncSvc.PullFor(context.Background(), branchID, nil)
	if err != nil {
		t.Fatal(err)
	}
	var gotStone bool
	for _, e := range pull.Entries {
		if e.Entity == "nomenclature" && e.RowID == nomID {
			gotStone = true
		}
	}
	if !gotStone {
		t.Fatal("tombstone не уехал филиалу — удалённая запись осталась бы у него навсегда")
	}
	if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
		t.Fatalf("ApplyPulled: %v", err)
	}

	// ─── Товар отвязан, но ЦЕЛ ────────────────────────────────────────────
	var ing models.Ingredient
	if err := gdb.First(&ing, "id = ?", ingID).Error; err != nil {
		t.Fatalf("ПОТЕРЯ ДАННЫХ: товар удалён вместе с записью каталога: %v", err)
	}
	if ing.NomenclatureID != nil {
		t.Errorf("товар всё ещё привязан к удалённой записи: %v", ing.NomenclatureID)
	}
	if !ing.Qty.Equal(decimal.MustFromString("42")) {
		t.Errorf("остаток товара = %s, want 42 — уборка справочника не должна трогать склад", ing.Qty.String())
	}

	// ─── Идемпотентность: tombstone приезжает на КАЖДОМ тике ──────────────
	var deltasBefore int64
	gdb.Model(&models.SyncLog{}).Count(&deltasBefore)
	for i := 0; i < 3; i++ {
		if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
			t.Fatalf("повторный ApplyPulled: %v", err)
		}
	}
	var deltasAfter int64
	gdb.Model(&models.SyncLog{}).Count(&deltasAfter)
	if deltasAfter != deltasBefore {
		t.Errorf("повторный tombstone создал %d дельт — бесконечный поток туда-обратно",
			deltasAfter-deltasBefore)
	}

	// ─── Привязать товар к удалённой записи больше нельзя ─────────────────
	ctxBranch := audit.WithActor(tenant.WithRestaurant(context.Background(), branchID), owner)
	if err := netSvc.LinkIngredient(ctxBranch, ingID, nomID); err == nil {
		t.Error("привязка к удалённой записи должна быть отклонена — tombstone тут же отвязал бы её обратно")
	}
}

// TestNomenclatureMaterializesIngredient — Фаза М: запись в каталоге сети
// заводит у филиала САМ ТОВАР с нулевым остатком.
//
// До этого номенклатура была чистой абстракцией: владелец создавал продукт в
// центре, на складах филиалов не менялось ничего, и товар появлялся там
// только после первого перемещения (нашли вживую — «создал Кофе в центре, в
// филиале его нет»).
//
// Отдельно проверяем два свойства, без которых фича сломала бы синк:
// идемпотентность (applyNomenclature зовётся на КАЖДОМ тике down-sync — повтор
// не должен ни менять склад, ни плодить дельты) и связывание уже имеющегося
// у филиала одноимённого товара вместо дубля.
func TestNomenclatureMaterializesIngredient(t *testing.T) {
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
		"sync_log", "ingredients", "warehouses", "nomenclature", "restaurants", "company_accounts",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	branchID := uuid.NewString()
	ot := "outlet"
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})
	// Склад «Продукты» — чтобы проверить, что новому товару он проставился
	// (BeforeCreate под SkipHooks сам не сработал бы, зовём его явно).
	prod, prodName := "products", "Продукты"
	whID := uuid.NewString()
	gdb.Create(&models.Warehouse{ID: whID, Name: &prodName, Kind: &prod, RestaurantID: &branchID})

	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	svc := service.NewSyncService(repo.New(gdb))
	ctx := context.Background()

	apply := func(nomID, name, unit string) {
		t.Helper()
		payload, _ := json.Marshal(models.Nomenclature{
			ID: nomID, AccountID: &accountID, Name: name, Unit: &unit,
		})
		if _, err := svc.ApplyPulled(ctx, service.IngestInput{Entries: []service.SyncEntry{
			{Entity: "nomenclature", RowID: nomID, Op: "upsert", Payload: payload},
		}}, branchID); err != nil {
			t.Fatalf("ApplyPulled: %v", err)
		}
	}

	// ─── Новый продукт сети → товар на складе филиала ─────────────────────
	coffeeNom := uuid.NewString()
	apply(coffeeNom, "Кофе", "кг")

	var ing models.Ingredient
	if err := gdb.Where("restaurant_id = ? AND nomenclature_id = ?", branchID, coffeeNom).
		First(&ing).Error; err != nil {
		t.Fatalf("товар не материализован на филиале: %v", err)
	}
	if ing.Name == nil || *ing.Name != "Кофе" {
		t.Errorf("имя = %v, want Кофе", ing.Name)
	}
	if !ing.Qty.IsZero() {
		t.Errorf("остаток = %s, want 0 (материализация не создаёт запасы)", ing.Qty.String())
	}
	if ing.WarehouseID == nil || *ing.WarehouseID != whID {
		t.Errorf("склад = %v, want %s (BeforeCreate под SkipHooks должен вызываться явно)", ing.WarehouseID, whID)
	}

	// ─── Идемпотентность: повторные тики ничего не меняют ─────────────────
	var deltasBefore int64
	gdb.Model(&models.SyncLog{}).Count(&deltasBefore)
	for i := 0; i < 3; i++ {
		apply(coffeeNom, "Кофе", "кг")
	}
	var cnt int64
	gdb.Model(&models.Ingredient{}).Where("restaurant_id = ? AND nomenclature_id = ?", branchID, coffeeNom).Count(&cnt)
	if cnt != 1 {
		t.Errorf("товаров с этой номенклатурой = %d, want 1 (повторный pull задублировал склад)", cnt)
	}
	var deltasAfter int64
	gdb.Model(&models.SyncLog{}).Count(&deltasAfter)
	if deltasAfter != deltasBefore {
		t.Errorf("повторный pull создал %d новых дельт — бесконечный поток «изменений» туда-обратно",
			deltasAfter-deltasBefore)
	}

	// ─── Свой одноимённый товар филиала — связывается, а не дублируется ───
	riceName, kg := "Рис", "кг"
	ownID := uuid.NewString()
	if err := gdb.Create(&models.Ingredient{
		ID: ownID, Name: &riceName, Unit: &kg, Qty: decimal.MustFromString("7"),
		PricePerUnit: decimal.MustFromString("12"), RestaurantID: &branchID,
	}).Error; err != nil {
		t.Fatal(err)
	}
	riceNom := uuid.NewString()
	apply(riceNom, "Рис", "кг")

	var rice []models.Ingredient
	gdb.Where("restaurant_id = ? AND name = ?", branchID, "Рис").Find(&rice)
	if len(rice) != 1 {
		t.Fatalf("товаров «Рис» = %d, want 1 (материализация задублировала уже заведённый филиалом)", len(rice))
	}
	if rice[0].ID != ownID {
		t.Errorf("остался не исходный товар филиала: %s vs %s", rice[0].ID, ownID)
	}
	if rice[0].NomenclatureID == nil || *rice[0].NomenclatureID != riceNom {
		t.Errorf("свой товар не связан с номенклатурой сети: %v", rice[0].NomenclatureID)
	}
	if !rice[0].Qty.Equal(decimal.MustFromString("7")) {
		t.Errorf("остаток своего товара затёрт: %s, want 7", rice[0].Qty.String())
	}
}
