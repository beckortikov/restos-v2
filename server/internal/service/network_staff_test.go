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

// TestNetworkStaff — Фаза П: весь персонал сети одним списком на central.
//
// Проверяет: сотрудники ВСЕХ филиалов видны с подписью филиала, счётчики по
// филиалам сходятся, чужая сеть не протекает, и — отдельно — что PIN/пароль
// не попадают в сериализованный ответ (учётки чужих филиалов на central это
// ровно тот случай, где утечка PIN-а была бы худшей из возможных).
func TestNetworkStaff(t *testing.T) {
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
	for _, tbl := range []string{"users", "restaurants", "company_accounts"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, outletID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	// Ресторан ЧУЖОЙ сети — его люди не должны попасть в выдачу.
	otherAcc := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: otherAcc, Name: "Другая сеть"})
	otherID := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: otherID, Name: "Чужой", AccountID: &otherAcc, Kind: &ot})

	mkUser := func(rid, name, role, pin string) {
		p := pin
		n, r := name, role
		if err := gdb.Create(&models.User{
			ID: uuid.NewString(), Name: &n, Role: &r, PIN: &p, Password: &p,
			RestaurantID: &rid, Salary: decimal.MustFromString("1000"),
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	mkUser(centralID, "Владелец", "owner", "1111")
	mkUser(outletID, "Кассир Филиала", "cashier", "2222")
	mkUser(outletID, "Повар Филиала", "cook", "3333")
	mkUser(otherID, "Чужой Кассир", "cashier", "9999")

	svc := service.NewNetworkService(repo.New(gdb), "")
	ctx := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID),
		audit.Actor{UserID: uuid.NewString(), Role: "owner"})

	// ─── Без права payroll.manage — отказ (в списке оклады всех филиалов) ──
	cashierID := uuid.NewString()
	cashierRole := "cashier"
	if err := gdb.Create(&models.User{ID: cashierID, Role: &cashierRole, RestaurantID: &centralID}).Error; err != nil {
		t.Fatal(err)
	}
	ctxCashier := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID),
		audit.Actor{UserID: cashierID, Role: cashierRole})
	if _, err := svc.Staff(ctxCashier); err == nil {
		t.Error("кассир без payroll.manage не должен видеть оклады всей сети")
	}

	out, err := svc.Staff(ctx)
	if err != nil {
		t.Fatalf("Staff: %v", err)
	}
	// 4 = владелец + кассир центра (заведён выше для проверки прав) + 2 в филиале.
	if out.TotalCount != 4 {
		t.Errorf("всего сотрудников = %d, want 4", out.TotalCount)
	}
	if len(out.Branches) != 2 {
		t.Fatalf("филиалов в сводке = %d, want 2", len(out.Branches))
	}
	// central первым — тот же порядок, что у остальных сетевых отчётов.
	if out.Branches[0].Kind == nil || *out.Branches[0].Kind != "central_warehouse" {
		t.Errorf("первым идёт не central: %+v", out.Branches[0])
	}
	countByName := map[string]int{}
	for _, b := range out.Branches {
		countByName[b.Name] = b.Count
	}
	if countByName["Центр"] != 2 || countByName["Филиал"] != 2 {
		t.Errorf("счётчики по филиалам = %v, want Центр:2 Филиал:2", countByName)
	}

	var sawForeign bool
	var branchOfCashier string
	for _, u := range out.Staff {
		if u.Name != nil && *u.Name == "Чужой Кассир" {
			sawForeign = true
		}
		if u.Name != nil && *u.Name == "Кассир Филиала" {
			branchOfCashier = u.BranchName
		}
	}
	if sawForeign {
		t.Error("УТЕЧКА: в персонал сети попал сотрудник чужого account_id")
	}
	if branchOfCashier != "Филиал" {
		t.Errorf("подпись филиала у сотрудника = %q, want «Филиал»", branchOfCashier)
	}

	// ─── PIN и пароль не должны сериализоваться ───────────────────────────
	blob, err := json.Marshal(out)
	if err != nil {
		t.Fatal(err)
	}
	for _, secret := range []string{"2222", "3333", `"pin"`, `"password"`} {
		if bytesContains(blob, secret) {
			t.Errorf("в JSON персонала сети утёк секрет %q", secret)
		}
	}

	// ─── Ресторан вне сети — понятный отказ, а не пустой список ───────────
	loneID := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: loneID, Name: "Одиночка"})
	if _, err := svc.Staff(tenant.WithRestaurant(context.Background(), loneID)); err == nil {
		t.Error("для ресторана вне сети ожидалась ошибка «not part of a network»")
	}
}

func bytesContains(b []byte, sub string) bool {
	return len(sub) > 0 && len(b) >= len(sub) && indexOf(string(b), sub) >= 0
}

func indexOf(s, sub string) int {
	for i := 0; i+len(sub) <= len(s); i++ {
		if s[i:i+len(sub)] == sub {
			return i
		}
	}
	return -1
}
