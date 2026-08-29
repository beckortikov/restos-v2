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
)

// TestNetworkPullTransfer — центр запрашивает списание со счёта филиала без
// его участия (Ф-Ц, 2026-08-25): «у филиала может не быть своего
// управляющего». Центр НЕ может списать чужой счёт напрямую (его копия
// financial_accounts — реплика, питается push-up'ом филиала) — вместо этого
// заводит money_transfer в статусе requested; реальное списание происходит
// САМО на филиале при получении документа down-sync'ом (applyRequestedTransfer),
// после чего статус становится sent и центр принимает его как обычно.
func TestNetworkPullTransfer(t *testing.T) {
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
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	kassa, schet := "Касса филиала", "Счёт центра"
	branchAccID, centralAccID := uuid.NewString(), uuid.NewString()
	gdb.Create(&models.FinancialAccount{
		ID: branchAccID, Name: &kassa, Balance: decimal.MustFromString("1000"),
		RestaurantID: &branchID, IsEnabled: true,
	})
	gdb.Create(&models.FinancialAccount{
		ID: centralAccID, Name: &schet, Balance: decimal.Zero,
		RestaurantID: &centralID, IsEnabled: true,
	})

	netSvc := service.NewNetworkService(repo.New(gdb), "")
	moneySvc := service.NewMoneyTransferService(repo.New(gdb))
	syncSvc := service.NewSyncService(repo.New(gdb))
	owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), owner)

	// ─── Гварды до создания ─────────────────────────────────────────────
	if _, err := netSvc.RequestMoneyTransfer(ctxCentral, service.RequestMoneyTransferInput{
		BranchID: centralID, FromAccountID: branchAccID, Amount: "100",
	}); err == nil {
		t.Error("запрос у самого себя должен быть отклонён")
	}
	if _, err := netSvc.RequestMoneyTransfer(ctxCentral, service.RequestMoneyTransferInput{
		BranchID: branchID, FromAccountID: centralAccID, Amount: "100",
	}); err == nil {
		t.Error("чужой (не принадлежащий филиалу) счёт должен быть отклонён")
	}
	ctxBranch := audit.WithActor(tenant.WithRestaurant(context.Background(), branchID), owner)
	if _, err := netSvc.RequestMoneyTransfer(ctxBranch, service.RequestMoneyTransferInput{
		BranchID: centralID, FromAccountID: centralAccID, Amount: "100",
	}); err == nil {
		t.Error("вызов не с центрального узла должен быть отклонён")
	}

	// ─── Центр запрашивает списание 250 со счёта филиала ───────────────────
	req, err := netSvc.RequestMoneyTransfer(ctxCentral, service.RequestMoneyTransferInput{
		BranchID: branchID, FromAccountID: branchAccID, Amount: "250",
	})
	if err != nil {
		t.Fatalf("RequestMoneyTransfer: %v", err)
	}
	if req.Status != "requested" {
		t.Errorf("status = %s, want requested", req.Status)
	}

	// До доставки филиалу — счёт филиала НЕ тронут (центр не может списать
	// чужой счёт напрямую).
	var branchAcc models.FinancialAccount
	gdb.First(&branchAcc, "id = ?", branchAccID)
	if !branchAcc.Balance.Equal(decimal.MustFromString("1000")) {
		t.Errorf("баланс филиала ДО доставки = %s, want 1000 (списания ещё не должно быть)", branchAcc.Balance.String())
	}

	// ─── Доставка филиалу: applyRequestedTransfer списывает сам ────────────
	// PullFor подтверждает, что документ УЕЗЖАЕТ вниз; сам применяем не через
	// его результат напрямую — в тесте центр и филиал сидят в ОДНОЙ таблице,
	// а в реальной сети это ДВЕ разные базы: у филиала этой строки ДО
	// доставки нет вообще. Удаляем локальную копию центра перед Apply, чтобы
	// первый INSERT был по-настоящему первым (иначе RowsAffected=0 сразу,
	// и applyRequestedTransfer никогда не вызовется — эту ловушку теста
	// поймали руками, отсюда и комментарий).
	pull, err := syncSvc.PullFor(context.Background(), branchID, nil)
	if err != nil {
		t.Fatalf("PullFor: %v", err)
	}
	found := false
	for _, e := range pull.Entries {
		if e.Entity == "money_transfers" && e.RowID == req.ID {
			found = true
		}
	}
	if !found {
		t.Fatal("requested-перевод не попал в down-payload PullFor для филиала")
	}
	if err := gdb.Exec("DELETE FROM money_transfers WHERE id = ?", req.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
		t.Fatalf("ApplyPulled: %v", err)
	}

	gdb.First(&branchAcc, "id = ?", branchAccID)
	if !branchAcc.Balance.Equal(decimal.MustFromString("750")) {
		t.Errorf("баланс филиала после применения = %s, want 750 (1000-250)", branchAcc.Balance.String())
	}
	var branchOp models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND type = ?", branchID, "out").First(&branchOp).Error; err != nil {
		t.Fatalf("финопа списания у филиала не создана: %v", err)
	}
	if branchOp.Activity == nil || *branchOp.Activity != "financial" {
		t.Errorf("activity = %v, want financial", branchOp.Activity)
	}
	if !branchOp.Amount.Equal(decimal.MustFromString("250")) {
		t.Errorf("сумма финопы = %s, want 250", branchOp.Amount.String())
	}
	var reqAfter models.MoneyTransfer
	gdb.First(&reqAfter, "id = ?", req.ID)
	if reqAfter.Status != "sent" {
		t.Errorf("status после применения = %s, want sent", reqAfter.Status)
	}
	if reqAfter.SentAt == nil {
		t.Error("sent_at не проставлен после применения")
	}

	// ─── Идемпотентность: та же доставка повторно НЕ списывает второй раз ──
	// (не через новый PullFor — он больше не вернёт requested, статус уже
	// sent; проверяем именно повторную ДОСТАВКУ ТОГО ЖЕ payload'а — ретрай
	// сети шлёт байт-в-байт то же самое).
	for i := 0; i < 3; i++ {
		if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
			t.Fatalf("повторная доставка (%d) не должна быть ошибкой: %v", i, err)
		}
	}
	gdb.First(&branchAcc, "id = ?", branchAccID)
	if !branchAcc.Balance.Equal(decimal.MustFromString("750")) {
		t.Errorf("ДВОЙНОЕ СПИСАНИЕ: баланс филиала = %s, want 750", branchAcc.Balance.String())
	}
	var opCount int64
	gdb.Model(&models.FinancialOperation{}).Where("restaurant_id = ? AND type = ?", branchID, "out").Count(&opCount)
	if opCount != 1 {
		t.Errorf("финопер списания = %d, want 1 (повтор задублировал)", opCount)
	}

	// ─── Центр видит sent и принимает как обычный перевод ──────────────────
	got, err := moneySvc.Receive(ctxCentral, req.ID, service.ReceiveMoneyTransferInput{ToAccountID: centralAccID})
	if err != nil {
		t.Fatalf("Receive: %v", err)
	}
	if got.Status != "received" {
		t.Errorf("status = %s, want received", got.Status)
	}
	var centralAcc models.FinancialAccount
	gdb.First(&centralAcc, "id = ?", centralAccID)
	if !centralAcc.Balance.Equal(decimal.MustFromString("250")) {
		t.Errorf("баланс центра = %s, want 250", centralAcc.Balance.String())
	}

	// ─── Недостаточно средств: вся заявка откатывается, не зависает навсегда ─
	short, err := netSvc.RequestMoneyTransfer(ctxCentral, service.RequestMoneyTransferInput{
		BranchID: branchID, FromAccountID: branchAccID, Amount: "5000",
	})
	if err != nil {
		t.Fatalf("RequestMoneyTransfer (short): %v", err)
	}
	pull2, err := syncSvc.PullFor(context.Background(), branchID, nil)
	if err != nil {
		t.Fatalf("PullFor (short): %v", err)
	}
	if err := gdb.Exec("DELETE FROM money_transfers WHERE id = ?", short.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := syncSvc.ApplyPulled(context.Background(), *pull2, branchID); err == nil {
		t.Error("применение при нехватке средств должно быть ошибкой, а не тихим успехом")
	}
	gdb.First(&branchAcc, "id = ?", branchAccID)
	if !branchAcc.Balance.Equal(decimal.MustFromString("750")) {
		t.Errorf("баланс филиала после неудачной попытки = %s, want 750 (транзакция обязана откатиться)", branchAcc.Balance.String())
	}
	// Ошибка обязана откатить ВСЮ транзакцию — включая сам upsert документа,
	// иначе он застрял бы локально в requested, а PullFor больше никогда не
	// прислал бы его снова (не подставное «не найден», а настоящее
	// подтверждение отката: строки не должно быть вообще).
	var shortRow models.MoneyTransfer
	if err := gdb.First(&shortRow, "id = ?", short.ID).Error; err == nil {
		t.Errorf("документ с нехваткой средств не должен был закрепиться в БД филиала, а нашёлся: %+v", shortRow)
	}
	var opCount2 int64
	gdb.Model(&models.FinancialOperation{}).Where("restaurant_id = ? AND type = ?", branchID, "out").Count(&opCount2)
	if opCount2 != 1 {
		t.Errorf("финопер списания после неудачной попытки = %d, want 1 (недостача не должна была списаться частично)", opCount2)
	}
}

// TestNetworkPullTransferAutoReceive — центр заранее знает СВОЙ счёт-назначение
// (2026-08-29: «мы заранее знаем куда перевести деньги... отдельно списать не
// надо будет потом») — RequestMoneyTransfer с ToAccountID. Приём должен
// произойти САМ, когда branch присылает sent обратно up-push'ом (Ingest),
// без вызова Receive(). Отдельный тест от TestNetworkPullTransfer: тот кроет
// ручной accept-путь (ToAccountID пуст), этот — автоматический.
func TestNetworkPullTransferAutoReceive(t *testing.T) {
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
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	kassa, schet := "Касса филиала", "Счёт центра"
	branchAccID, centralAccID := uuid.NewString(), uuid.NewString()
	gdb.Create(&models.FinancialAccount{
		ID: branchAccID, Name: &kassa, Balance: decimal.MustFromString("1000"),
		RestaurantID: &branchID, IsEnabled: true,
	})
	gdb.Create(&models.FinancialAccount{
		ID: centralAccID, Name: &schet, Balance: decimal.Zero,
		RestaurantID: &centralID, IsEnabled: true,
	})

	netSvc := service.NewNetworkService(repo.New(gdb), "")
	syncSvc := service.NewSyncService(repo.New(gdb))
	owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), owner)

	// ─── Гвард: чужой (не central) счёт-назначение отклоняется ─────────────
	otherID := uuid.NewString()
	other := "Чужой"
	gdb.Create(&models.Restaurant{ID: otherID, Name: "Другая сеть", Kind: &ot})
	otherAccID := uuid.NewString()
	gdb.Create(&models.FinancialAccount{ID: otherAccID, Name: &other, RestaurantID: &otherID, IsEnabled: true})
	if _, err := netSvc.RequestMoneyTransfer(ctxCentral, service.RequestMoneyTransferInput{
		BranchID: branchID, FromAccountID: branchAccID, Amount: "100", ToAccountID: &otherAccID,
	}); err == nil {
		t.Error("чужой (не central) счёт-назначение должен быть отклонён")
	}

	// ─── Центр запрашивает списание 250, ЗАРАНЕЕ указав свой счёт-приёмник ──
	req, err := netSvc.RequestMoneyTransfer(ctxCentral, service.RequestMoneyTransferInput{
		BranchID: branchID, FromAccountID: branchAccID, Amount: "250", ToAccountID: &centralAccID,
	})
	if err != nil {
		t.Fatalf("RequestMoneyTransfer: %v", err)
	}
	if req.Status != "requested" {
		t.Errorf("status = %s, want requested", req.Status)
	}
	if req.SuggestedToAccountID == nil || *req.SuggestedToAccountID != centralAccID {
		t.Errorf("suggested_to_account_id = %v, want %s", req.SuggestedToAccountID, centralAccID)
	}

	// ─── Доставка филиалу: applyRequestedTransfer списывает сам (как обычно) ─
	pull, err := syncSvc.PullFor(context.Background(), branchID, nil)
	if err != nil {
		t.Fatalf("PullFor: %v", err)
	}
	if err := gdb.Exec("DELETE FROM money_transfers WHERE id = ?", req.ID).Error; err != nil {
		t.Fatal(err)
	}
	if _, err := syncSvc.ApplyPulled(context.Background(), *pull, branchID); err != nil {
		t.Fatalf("ApplyPulled: %v", err)
	}
	var branchAcc models.FinancialAccount
	gdb.First(&branchAcc, "id = ?", branchAccID)
	if !branchAcc.Balance.Equal(decimal.MustFromString("750")) {
		t.Errorf("баланс филиала после списания = %s, want 750", branchAcc.Balance.String())
	}
	var sentRow models.MoneyTransfer
	gdb.First(&sentRow, "id = ?", req.ID)
	if sentRow.Status != "sent" {
		t.Fatalf("status на филиале = %s, want sent", sentRow.Status)
	}

	// ─── Филиал пушет sent обратно наверх (Ingest) — central должен принять
	// АВТОМАТИЧЕСКИ, без вызова Receive() ────────────────────────────────────
	payload, _ := json.Marshal(sentRow)
	batch := service.IngestInput{Entries: []service.SyncEntry{
		{Entity: "money_transfers", RowID: req.ID, Op: "update", Payload: payload},
	}}
	if _, err := syncSvc.Ingest(context.Background(), batch, ""); err != nil {
		t.Fatalf("Ingest: %v", err)
	}

	var received models.MoneyTransfer
	gdb.First(&received, "id = ?", req.ID)
	if received.Status != "received" {
		t.Errorf("status после auto-receive = %s, want received", received.Status)
	}
	if received.ToAccountID == nil || *received.ToAccountID != centralAccID {
		t.Errorf("to_account_id = %v, want %s", received.ToAccountID, centralAccID)
	}
	if received.ReceivedAt == nil {
		t.Error("received_at не проставлен после auto-receive")
	}
	var centralAcc models.FinancialAccount
	gdb.First(&centralAcc, "id = ?", centralAccID)
	if !centralAcc.Balance.Equal(decimal.MustFromString("250")) {
		t.Errorf("баланс central = %s, want 250", centralAcc.Balance.String())
	}
	var centralOp models.FinancialOperation
	if err := gdb.Where("restaurant_id = ? AND type = ?", centralID, "in").First(&centralOp).Error; err != nil {
		t.Fatalf("финопа зачисления у central не создана: %v", err)
	}
	if centralOp.IsAuto == nil || !*centralOp.IsAuto {
		t.Error("финопа auto-receive должна быть is_auto=true")
	}
	if !centralOp.Amount.Equal(decimal.MustFromString("250")) {
		t.Errorf("сумма финопы = %s, want 250", centralOp.Amount.String())
	}

	// ─── Идемпотентность: повторная доставка ТОГО ЖЕ payload'а (ретрай сети)
	// не должна задвоить зачисление ────────────────────────────────────────
	for i := 0; i < 3; i++ {
		if _, err := syncSvc.Ingest(context.Background(), batch, ""); err != nil {
			t.Fatalf("повторный Ingest (%d) не должен быть ошибкой: %v", i, err)
		}
	}
	gdb.First(&centralAcc, "id = ?", centralAccID)
	if !centralAcc.Balance.Equal(decimal.MustFromString("250")) {
		t.Errorf("ДВОЙНОЕ ЗАЧИСЛЕНИЕ: баланс central = %s, want 250", centralAcc.Balance.String())
	}
	var opCount int64
	gdb.Model(&models.FinancialOperation{}).Where("restaurant_id = ? AND type = ?", centralID, "in").Count(&opCount)
	if opCount != 1 {
		t.Errorf("финопер зачисления central = %d, want 1 (повтор задублировал)", opCount)
	}
}
