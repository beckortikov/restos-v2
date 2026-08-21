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

// TestNetworkDetachBranch — Фаза У: отключение филиала от сети.
//
// Ключевое свойство, ради которого выбран именно сброс account_id, а не
// удаление строки: филиал ИСЧЕЗАЕТ из всех сетевых списков и отчётов разом, но
// НИ ОДНА строка его данных не пропадает — повторное подключение возвращает
// всё. Проверяем оба конца, включая down-sync (PullFor обязан замолчать) и
// восстановление после повторного присоединения.
func TestNetworkDetachBranch(t *testing.T) {
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
		"financial_operations", "nomenclature", "restaurants", "company_accounts",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	// Данные филиала на central + запись каталога, которую он получал вниз.
	inType, cat, date := "in", "revenue", "2026-08-01"
	opID := uuid.NewString()
	gdb.Create(&models.FinancialOperation{
		ID: opID, Type: &inType, Category: &cat, Date: &date,
		Amount: decimal.MustFromString("5000"), RestaurantID: &branchID,
	})
	kg := "кг"
	gdb.Create(&models.Nomenclature{ID: uuid.NewString(), AccountID: &accountID, Name: "Рис", Unit: &kg})

	svc := service.NewNetworkService(repo.New(gdb), "")
	syncSvc := service.NewSyncService(repo.New(gdb))
	owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), owner)

	// ─── Гварды ───────────────────────────────────────────────────────────
	if err := svc.DetachBranch(ctxCentral, centralID); err == nil {
		t.Error("отключение самого центрального узла должно быть запрещено — сеть перестала бы существовать")
	}
	ctxCashier := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID),
		audit.Actor{UserID: uuid.NewString(), Role: "cashier"})
	if err := svc.DetachBranch(ctxCashier, branchID); err == nil {
		t.Error("не-владелец не должен отключать филиалы")
	}
	ctxBranch := audit.WithActor(tenant.WithRestaurant(context.Background(), branchID), owner)
	if err := svc.DetachBranch(ctxBranch, centralID); err == nil {
		t.Error("филиал (не central) не должен управлять составом сети")
	}

	// До отключения филиал виден и получает down-sync.
	before, err := svc.ListBranches(ctxCentral)
	if err != nil {
		t.Fatal(err)
	}
	if len(before) != 2 {
		t.Fatalf("филиалов до отключения = %d, want 2", len(before))
	}
	pullBefore, err := syncSvc.PullFor(context.Background(), branchID, nil)
	if err != nil {
		t.Fatal(err)
	}
	if len(pullBefore.Entries) == 0 {
		t.Fatal("до отключения филиал обязан получать каталог/соседей — иначе тест ниже ничего не докажет")
	}

	// ─── Отключение ───────────────────────────────────────────────────────
	if err := svc.DetachBranch(ctxCentral, branchID); err != nil {
		t.Fatalf("DetachBranch: %v", err)
	}

	after, err := svc.ListBranches(ctxCentral)
	if err != nil {
		t.Fatal(err)
	}
	if len(after) != 1 || after[0].ID != centralID {
		t.Errorf("после отключения в сети = %+v, want только central", after)
	}
	// Сетевые отчёты — через тот же branchesForAccount, проверяем на выручке.
	sum, err := svc.Summary(ctxCentral, "", "")
	if err != nil {
		t.Fatal(err)
	}
	for _, b := range sum.Branches {
		if b.ID == branchID {
			t.Error("отключённый филиал всё ещё в сводке по сети")
		}
	}
	// Down-sync: данные ЧЛЕНСТВА в сети (каталог, мастер-меню, соседи) больше
	// не уезжают — они приходят только при непустом account_id.
	pullAfter, err := syncSvc.PullFor(context.Background(), branchID, nil)
	if err != nil {
		t.Fatalf("PullFor после отключения: %v", err)
	}
	for _, e := range pullAfter.Entries {
		switch e.Entity {
		case "nomenclature", "network_menu_items", "restaurants":
			t.Errorf("отключённому филиалу всё ещё уезжает %q — это данные членства в сети", e.Entity)
		}
	}

	// А вот НЕЗАВЕРШЁННЫЕ документы доезжать обязаны, и это осознанно, а не
	// недосмотр: деньги/товар уже списаны у отправителя. Оборви доставку — и
	// перевод повиснет в воздухе навсегда (у отправителя ушло, у получателя не
	// пришло). Отключение убирает филиал из состава сети, но не аннулирует
	// обязательства, возникшие до него.
	pendingID := uuid.NewString()
	sent := "sent"
	gdb.Create(&models.MoneyTransfer{
		ID: pendingID, AccountID: &accountID, FromRestaurantID: &centralID,
		ToRestaurantID: &branchID, Amount: decimal.MustFromString("2500"), Status: sent,
	})
	pullPending, err := syncSvc.PullFor(context.Background(), branchID, nil)
	if err != nil {
		t.Fatal(err)
	}
	var gotPending bool
	for _, e := range pullPending.Entries {
		if e.Entity == "money_transfers" && e.RowID == pendingID {
			gotPending = true
		}
	}
	if !gotPending {
		t.Error("незавершённый перевод не доехал до отключённого филиала — деньги отправителя повисли бы навсегда")
	}

	// ─── Данные целы (не удаление, а исключение из сети) ──────────────────
	var opCnt int64
	gdb.Model(&models.FinancialOperation{}).Where("id = ?", opID).Count(&opCnt)
	if opCnt != 1 {
		t.Error("ПОТЕРЯ ДАННЫХ: финоперация отключённого филиала удалена")
	}
	var rest models.Restaurant
	if err := gdb.First(&rest, "id = ?", branchID).Error; err != nil {
		t.Fatalf("строка ресторана удалена, а должна остаться: %v", err)
	}
	if rest.Name != "Филиал" {
		t.Errorf("имя филиала затёрто: %q", rest.Name)
	}

	// Повторное отключение — уже не в сети, честный 404, а не тихий успех.
	if err := svc.DetachBranch(ctxCentral, branchID); err == nil {
		t.Error("повторное отключение должно вернуть NOT_FOUND")
	}

	// ─── Возврат в сеть восстанавливает видимость ─────────────────────────
	gdb.Model(&models.Restaurant{}).Where("id = ?", branchID).Update("account_id", accountID)
	back, err := svc.ListBranches(ctxCentral)
	if err != nil {
		t.Fatal(err)
	}
	if len(back) != 2 {
		t.Errorf("после повторного подключения филиалов = %d, want 2", len(back))
	}
}
