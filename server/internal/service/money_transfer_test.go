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
	"github.com/restos/restos-v4/server/internal/synclog"
)

// TestMoneyTransfer_Flow — сквозной тест перевода денег между узлами сети
// (ADR-003, Фаза Д): филиал → центральный узел (инкассация).
//
// Проверяет: списание у отправителя, зачисление у получателя на ВЫБРАННЫЙ им
// счёт, парные финопы с activity='financial' (перевод не должен попасть в
// ОПиУ ни на одной стороне), идемпотентность приёма (двойное зачисление =
// деньги из воздуха), гварды сети/прав/остатка.
func TestMoneyTransfer_Flow(t *testing.T) {
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
		if err := gdb.Exec("DELETE FROM " + tbl).Error; err != nil {
			t.Fatalf("clean %s: %v", tbl, err)
		}
	}

	accountID := uuid.NewString()
	if err := gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"}).Error; err != nil {
		t.Fatal(err)
	}
	centralID, outletID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	if err := gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал-1", AccountID: &accountID, Kind: &ot}).Error; err != nil {
		t.Fatal(err)
	}
	// Ресторан ВНЕ сети — для гварда «другая сеть».
	otherID := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: otherID, Name: "Чужой"}).Error; err != nil {
		t.Fatal(err)
	}

	// Счета: касса филиала (1000) и счёт центра (0).
	kassa, schet := "Касса филиала", "Счёт центра"
	outletAccID, centralAccID := uuid.NewString(), uuid.NewString()
	if err := gdb.Create(&models.FinancialAccount{
		ID: outletAccID, Name: &kassa, Balance: decimal.MustFromString("1000"),
		RestaurantID: &outletID, IsEnabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}
	if err := gdb.Create(&models.FinancialAccount{
		ID: centralAccID, Name: &schet, Balance: decimal.Zero,
		RestaurantID: &centralID, IsEnabled: true,
	}).Error; err != nil {
		t.Fatal(err)
	}

	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	svc := service.NewMoneyTransferService(repo.New(gdb))
	owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
	ctxOutlet := audit.WithActor(tenant.WithRestaurant(context.Background(), outletID), owner)
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), owner)

	// ─── Гварды до создания ───────────────────────────────────────────────
	if _, err := svc.Create(ctxOutlet, service.CreateMoneyTransferInput{
		ToRestaurantID: outletID, FromAccountID: outletAccID, Amount: "100",
	}); err == nil {
		t.Error("перевод самому себе должен быть отклонён")
	}
	if _, err := svc.Create(ctxOutlet, service.CreateMoneyTransferInput{
		ToRestaurantID: otherID, FromAccountID: outletAccID, Amount: "100",
	}); err == nil {
		t.Error("перевод в чужую сеть должен быть отклонён")
	}
	if _, err := svc.Create(ctxOutlet, service.CreateMoneyTransferInput{
		ToRestaurantID: centralID, FromAccountID: outletAccID, Amount: "0",
	}); err == nil {
		t.Error("нулевая сумма должна быть отклонена")
	}
	// Ф-С2: предложенный счёт-назначение обязан принадлежать получателю —
	// чужой (в т.ч. счёт самого отправителя) отклоняется.
	if _, err := svc.Create(ctxOutlet, service.CreateMoneyTransferInput{
		ToRestaurantID: centralID, FromAccountID: outletAccID, Amount: "100",
		SuggestedToAccountID: &outletAccID,
	}); err == nil {
		t.Error("предложенный счёт, не принадлежащий получателю, должен быть отклонён")
	}
	// Валидный suggested сохраняется на документе (и уедет вниз обычной
	// доставкой — PullFor маршалит модель целиком).
	withSuggested, err := svc.Create(ctxOutlet, service.CreateMoneyTransferInput{
		ToRestaurantID: centralID, FromAccountID: outletAccID, Amount: "0.01",
		SuggestedToAccountID: &centralAccID,
	})
	if err == nil {
		if withSuggested.SuggestedToAccountID == nil || *withSuggested.SuggestedToAccountID != centralAccID {
			t.Errorf("suggested_to_account_id не сохранился: %+v", withSuggested.SuggestedToAccountID)
		}
		// Прибираем: дальше тест считает баланс кассы филиала от 1000.
		gdb.Exec("DELETE FROM money_transfers WHERE id = ?", withSuggested.ID)
		gdb.Exec("DELETE FROM financial_operations WHERE amount = 0.01")
		gdb.Exec("UPDATE financial_accounts SET balance = 1000 WHERE id = ?", outletAccID)
	} else {
		t.Errorf("валидный suggested отклонён: %v", err)
	}
	if _, err := svc.Create(ctxOutlet, service.CreateMoneyTransferInput{
		ToRestaurantID: centralID, FromAccountID: outletAccID, Amount: "5000",
	}); err == nil {
		t.Error("сумма больше остатка счёта должна быть отклонена")
	}
	// Кассир не управляет финансами — finance.manage у него нет.
	cashierID := uuid.NewString()
	cashierRole := "cashier"
	if err := gdb.Create(&models.User{ID: cashierID, Role: &cashierRole, RestaurantID: &outletID}).Error; err != nil {
		t.Fatal(err)
	}
	ctxCashier := audit.WithActor(tenant.WithRestaurant(context.Background(), outletID),
		audit.Actor{UserID: cashierID, Role: cashierRole})
	if _, err := svc.Create(ctxCashier, service.CreateMoneyTransferInput{
		ToRestaurantID: centralID, FromAccountID: outletAccID, Amount: "100",
	}); err == nil {
		t.Error("кассир без finance.manage не должен переводить деньги между узлами")
	}

	// ─── Отправка: филиал → центр, 300 ────────────────────────────────────
	tr, err := svc.Create(ctxOutlet, service.CreateMoneyTransferInput{
		ToRestaurantID: centralID, FromAccountID: outletAccID, Amount: "300",
	})
	if err != nil {
		t.Fatalf("Create: %v", err)
	}
	if tr.Status != "sent" {
		t.Errorf("status = %s, want sent", tr.Status)
	}
	if tr.FromAccountName == nil || *tr.FromAccountName != kassa {
		t.Errorf("from_account_name = %v, want %q (денормализация для получателя)", tr.FromAccountName, kassa)
	}

	// Списано у отправителя: 1000 − 300 = 700.
	var srcAcc models.FinancialAccount
	gdb.First(&srcAcc, "id = ?", outletAccID)
	if !srcAcc.Balance.Equal(decimal.MustFromString("700")) {
		t.Errorf("баланс отправителя = %s, want 700", srcAcc.Balance.String())
	}
	// У получателя ПОКА ничего — деньги в пути.
	var dstAcc models.FinancialAccount
	gdb.First(&dstAcc, "id = ?", centralAccID)
	if !dstAcc.Balance.IsZero() {
		t.Errorf("баланс получателя до приёма = %s, want 0 (деньги ещё в пути)", dstAcc.Balance.String())
	}

	// Финопа списания: out + activity=financial (иначе перевод попадёт в ОПиУ).
	var outOp models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND type = ?", outletID, "out").First(&outOp).Error; err != nil {
		t.Fatalf("финопа списания не создана: %v", err)
	}
	if outOp.Activity == nil || *outOp.Activity != "financial" {
		t.Errorf("activity = %v, want financial (перевод не операционный расход)", outOp.Activity)
	}
	if !outOp.Amount.Equal(decimal.MustFromString("300")) {
		t.Errorf("сумма финопы = %s, want 300", outOp.Amount.String())
	}

	// sync-дельта документа записана.
	var logCnt int64
	gdb.Model(&models.SyncLog{}).Where("table_name = ? AND row_id = ?", "money_transfers", tr.ID).Count(&logCnt)
	if logCnt == 0 {
		t.Error("sync_log не содержит money_transfers — central о переводе не узнает")
	}

	// ─── Приём не тем узлом / не на тот счёт ──────────────────────────────
	if _, err := svc.Receive(ctxOutlet, tr.ID, service.ReceiveMoneyTransferInput{ToAccountID: outletAccID}); err == nil {
		t.Error("отправитель не может принять собственный перевод")
	}
	if _, err := svc.Receive(ctxCentral, tr.ID, service.ReceiveMoneyTransferInput{ToAccountID: outletAccID}); err == nil {
		t.Error("зачисление на ЧУЖОЙ счёт (счёт отправителя) должно быть отклонено")
	}

	// ─── Приём получателем ────────────────────────────────────────────────
	got, err := svc.Receive(ctxCentral, tr.ID, service.ReceiveMoneyTransferInput{ToAccountID: centralAccID})
	if err != nil {
		t.Fatalf("Receive: %v", err)
	}
	if got.Status != "received" {
		t.Errorf("status = %s, want received", got.Status)
	}
	if got.ToAccountID == nil || *got.ToAccountID != centralAccID {
		t.Errorf("to_account_id = %v, want %s", got.ToAccountID, centralAccID)
	}
	gdb.First(&dstAcc, "id = ?", centralAccID)
	if !dstAcc.Balance.Equal(decimal.MustFromString("300")) {
		t.Errorf("баланс получателя = %s, want 300", dstAcc.Balance.String())
	}
	var inOp models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND type = ?", centralID, "in").First(&inOp).Error; err != nil {
		t.Fatalf("финопа зачисления не создана: %v", err)
	}
	if inOp.Activity == nil || *inOp.Activity != "financial" {
		t.Errorf("activity зачисления = %v, want financial", inOp.Activity)
	}
	if inOp.Counterparty == nil || *inOp.Counterparty != "Филиал-1" {
		t.Errorf("counterparty = %v, want «Филиал-1» (имя из заглушки restaurants)", inOp.Counterparty)
	}

	// ─── Идемпотентность приёма: НИ КОПЕЙКИ сверх ─────────────────────────
	// Ретрай сети/двойной клик не имеет права зачислить деньги дважды.
	if _, err := svc.Receive(ctxCentral, tr.ID, service.ReceiveMoneyTransferInput{ToAccountID: centralAccID}); err != nil {
		t.Fatalf("повторный Receive должен быть идемпотентным, а не ошибкой: %v", err)
	}
	gdb.First(&dstAcc, "id = ?", centralAccID)
	if !dstAcc.Balance.Equal(decimal.MustFromString("300")) {
		t.Errorf("ДВОЙНОЕ ЗАЧИСЛЕНИЕ: баланс = %s, want 300", dstAcc.Balance.String())
	}
	var inOpCnt int64
	gdb.Model(&models.FinancialOperation{}).Where("restaurant_id = ? AND type = ?", centralID, "in").Count(&inOpCnt)
	if inOpCnt != 1 {
		t.Errorf("финопер зачисления = %d, want 1 (повтор не должен плодить проводки)", inOpCnt)
	}

	// ─── Сумма по сети сходится в ноль ────────────────────────────────────
	// Деньги не появились и не исчезли — только переехали между узлами.
	var total decimal.Decimal
	gdb.Model(&models.FinancialAccount{}).Select("COALESCE(SUM(balance), 0)").Scan(&total)
	if !total.Equal(decimal.MustFromString("1000")) {
		t.Errorf("сумма балансов сети = %s, want 1000 (перевод не создаёт и не теряет деньги)", total.String())
	}
}
