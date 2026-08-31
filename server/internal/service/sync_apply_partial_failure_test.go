//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// #26 (живой инцидент 2026-08-31, Macburger/Гулакандоз): центр запросил
// списание с трёх разных счетов филиала одним pull-батчем; на первом счёте
// не хватило денег (случайный дубль более раннего запроса). apply()
// (sync_ingest.go) раньше прерывал ВЕСЬ батч на первой же ошибке строки —
// два ДРУГИХ запроса с других, полностью платёжеспособных счетов зависали
// «за компанию» с проблемным, хотя сами по себе прошли бы. Этот тест
// воспроизводит ровно эту форму (плохая заявка ПЕРВОЙ в очереди, две
// нормальных — следом) и фиксирует, что после фикса они применяются
// независимо от соседки.
func TestSyncApply_OneEntryFailureDoesNotBlockSiblings(t *testing.T) {
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
		"sync_log", "money_transfers", "financial_operations", "financial_accounts",
		"restaurants", "company_accounts",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Гулакандоз", AccountID: &accountID, Kind: &ot})

	// Три счёта филиала — ровно как «Дс» (мало денег), «Наличные», «ЭСХАТА»
	// в реальном инциденте: первый не может покрыть запрос, два других легко.
	nameDS, nameCash, nameEsx := "Дс", "Наличные", "ЭСХАТА"
	accDS, accCash, accEsx := uuid.NewString(), uuid.NewString(), uuid.NewString()
	gdb.Create(&models.FinancialAccount{ID: accDS, Name: &nameDS, Balance: decimal.MustFromString("468"), RestaurantID: &branchID, IsEnabled: true})
	gdb.Create(&models.FinancialAccount{ID: accCash, Name: &nameCash, Balance: decimal.MustFromString("27997"), RestaurantID: &branchID, IsEnabled: true})
	gdb.Create(&models.FinancialAccount{ID: accEsx, Name: &nameEsx, Balance: decimal.MustFromString("1159"), RestaurantID: &branchID, IsEnabled: true})
	centralAccName := "Счёт центра"
	centralAcc := uuid.NewString()
	gdb.Create(&models.FinancialAccount{ID: centralAcc, Name: &centralAccName, Balance: decimal.Zero, RestaurantID: &centralID, IsEnabled: true})

	netSvc := service.NewNetworkService(repo.New(gdb), "")
	syncSvc := service.NewSyncService(repo.New(gdb))
	owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), owner)

	// Заявка №1 (проблемная, создана ПЕРВОЙ — как в инциденте): 4920 с
	// «Дс», где только 468 — заведомо провалится.
	bad, err := netSvc.RequestMoneyTransfer(ctxCentral, service.RequestMoneyTransferInput{
		BranchID: branchID, FromAccountID: accDS, Amount: "4920", ToAccountID: &centralAcc,
	})
	if err != nil {
		t.Fatalf("RequestMoneyTransfer (bad): %v", err)
	}
	// Заявки №2 и №3 — платёжеспособные, созданы следом.
	good1, err := netSvc.RequestMoneyTransfer(ctxCentral, service.RequestMoneyTransferInput{
		BranchID: branchID, FromAccountID: accCash, Amount: "22925", ToAccountID: &centralAcc,
	})
	if err != nil {
		t.Fatalf("RequestMoneyTransfer (good1): %v", err)
	}
	good2, err := netSvc.RequestMoneyTransfer(ctxCentral, service.RequestMoneyTransferInput{
		BranchID: branchID, FromAccountID: accEsx, Amount: "859", ToAccountID: &centralAcc,
	})
	if err != nil {
		t.Fatalf("RequestMoneyTransfer (good2): %v", err)
	}

	// Доставка филиалу ОДНИМ батчем — все три requested-заявки в одном pull,
	// ровно как это происходит в проде (PullFor отдаёт все текущие requested
	// разом, не по одной).
	pull, err := syncSvc.PullFor(context.Background(), branchID, nil)
	if err != nil {
		t.Fatalf("PullFor: %v", err)
	}
	// >= 3, не ==: PullFor попутно шлёт «заглушку соседа» (entity=restaurants,
	// applyRestaurantStub) — обычная, ни к чему не относящаяся строка того же
	// батча, а не что-то, что эта проверка должна знать наизусть.
	moneyEntries := 0
	for _, e := range pull.Entries {
		if e.Entity == "money_transfers" {
			moneyEntries++
		}
	}
	if moneyEntries != 3 {
		t.Fatalf("money_transfers entries в pull = %d, want 3 (всего entries: %d)", moneyEntries, len(pull.Entries))
	}
	for _, id := range []string{bad.ID, good1.ID, good2.ID} {
		if err := gdb.Exec("DELETE FROM money_transfers WHERE id = ?", id).Error; err != nil {
			t.Fatal(err)
		}
	}

	res, applyErr := syncSvc.ApplyPulled(context.Background(), *pull, branchID)
	if applyErr == nil {
		t.Fatal("ожидалась ошибка — одна из трёх заявок должна упасть на нехватке денег")
	}
	if res == nil {
		t.Fatal("res не должен быть nil даже при частичной ошибке батча")
	}
	// >= 2, не ==: помимо двух платёжеспособных заявок в батче едет попутная
	// «заглушка соседа» (entity=restaurants), она тоже применяется успешно и
	// тоже считается в Applied — это не то, что здесь проверяется.
	if res.Applied < 2 {
		t.Errorf("res.Applied = %d, want >= 2 (две платёжеспособные заявки обязаны пройти несмотря на третью)", res.Applied)
	}
	if res.Failed != 1 {
		t.Errorf("res.Failed = %d, want 1", res.Failed)
	}

	// Платёжеспособные счета списаны корректно...
	var cash, esx models.FinancialAccount
	gdb.First(&cash, "id = ?", accCash)
	if !cash.Balance.Equal(decimal.MustFromString("5072")) { // 27997-22925
		t.Errorf("баланс «Наличные» = %s, want 5072", cash.Balance.String())
	}
	gdb.First(&esx, "id = ?", accEsx)
	if !esx.Balance.Equal(decimal.MustFromString("300")) { // 1159-859
		t.Errorf("баланс «ЭСХАТА» = %s, want 300", esx.Balance.String())
	}
	// ...а проблемный — НЕТ, транзакция для него откатилась целиком.
	var ds models.FinancialAccount
	gdb.First(&ds, "id = ?", accDS)
	if !ds.Balance.Equal(decimal.MustFromString("468")) {
		t.Errorf("баланс «Дс» = %s, want 468 (не должен был измениться)", ds.Balance.String())
	}

	// Статусы документов подтверждают то же самое на уровне money_transfers.
	var good1Row, good2Row models.MoneyTransfer
	gdb.First(&good1Row, "id = ?", good1.ID)
	if good1Row.Status != "sent" {
		t.Errorf("good1.status = %s, want sent", good1Row.Status)
	}
	gdb.First(&good2Row, "id = ?", good2.ID)
	if good2Row.Status != "sent" {
		t.Errorf("good2.status = %s, want sent", good2Row.Status)
	}
	var badRow models.MoneyTransfer
	if err := gdb.First(&badRow, "id = ?", bad.ID).Error; err == nil {
		t.Errorf("проблемная заявка не должна была закрепиться в БД филиала, а нашлась: %+v", badRow)
	}

	// Повторная доставка ТОГО ЖЕ батча (следующий тик пуллера в реальности) —
	// good1/good2 уже применены (insert-if-absent no-op, без повторного
	// списания), проблемная заявка продолжает самоисцеляться попыткой, но
	// по-прежнему не хватает денег — ошибка сигналится снова.
	if _, err2 := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err2 == nil {
		t.Fatal("повторная доставка того же батча всё ещё должна сигналить об ошибке (проблемная заявка не решена)")
	}
	gdb.First(&cash, "id = ?", accCash)
	if !cash.Balance.Equal(decimal.MustFromString("5072")) {
		t.Errorf("ДВОЙНОЕ СПИСАНИЕ «Наличные» после повтора: баланс = %s, want 5072", cash.Balance.String())
	}
	gdb.First(&esx, "id = ?", accEsx)
	if !esx.Balance.Equal(decimal.MustFromString("300")) {
		t.Errorf("ДВОЙНОЕ СПИСАНИЕ «ЭСХАТА» после повтора: баланс = %s, want 300", esx.Balance.String())
	}
}
