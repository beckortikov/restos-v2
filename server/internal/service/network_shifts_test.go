//go:build integration

package service_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestNetworkShifts — «Операции» скрыты на central целиком (Ф-С4), владелец
// просил сводный обзор смен филиалов взамен. cash_shifts уже реплицирована
// (Dashboard читает её для open_shifts) — проверяем сводный список по сети
// (агрегаты, фильтр по branch_id, дискрепансия закрытой смены) и делегирование
// Z-отчёта одной смены через подмену tenant.
func TestNetworkShifts(t *testing.T) {
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
		"cash_shifts", "financial_accounts", "users", "restaurants", "company_accounts",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	// Чужая сеть — её смена не должна утечь в наш список/Z-отчёт.
	otherAccountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: otherAccountID, Name: "Чужая сеть"})
	outsiderID := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: outsiderID, Name: "Чужой", AccountID: &otherAccountID, Kind: &ot})

	kassa := "Касса филиала"
	accID := uuid.NewString()
	gdb.Create(&models.FinancialAccount{
		ID: accID, Name: &kassa, Balance: decimal.MustFromString("1000"),
		RestaurantID: &branchID, IsEnabled: true,
	})

	cashierName, cashierRole := "Кассир Филиала", "cashier"
	cashierID := uuid.NewString()
	gdb.Create(&models.User{ID: cashierID, Name: &cashierName, Role: &cashierRole, RestaurantID: &branchID})

	openStatus, closedStatus := "open", "closed"
	now := time.Now().UTC()
	openedAtOpen := now.Add(-2 * time.Hour)
	openedAtClosed := now.Add(-26 * time.Hour)
	closedAt := now.Add(-25 * time.Hour)
	expected := decimal.MustFromString("5000")
	closing := decimal.MustFromString("4900") // недостача 100

	openShiftID := uuid.NewString()
	gdb.Create(&models.CashShift{
		ID: openShiftID, RestaurantID: &branchID, AccountID: &accID, OpenedBy: &cashierID,
		Status: &openStatus, OpenedAt: openedAtOpen,
		OpeningBalance: decimal.MustFromString("1000"),
		CashRevenue:    decimal.MustFromString("3000"), CardRevenue: decimal.MustFromString("2000"),
		OrdersCount: intPtr(10),
	})
	closedShiftID := uuid.NewString()
	gdb.Create(&models.CashShift{
		ID: closedShiftID, RestaurantID: &branchID, AccountID: &accID, OpenedBy: &cashierID, ClosedBy: &cashierID,
		Status: &closedStatus, OpenedAt: openedAtClosed, ClosedAt: &closedAt,
		OpeningBalance: decimal.MustFromString("1000"), ClosingBalance: closing, ExpectedCash: &expected,
		CashRevenue: decimal.MustFromString("4000"), CardRevenue: decimal.MustFromString("1000"),
		OrdersCount: intPtr(15),
	})
	outsiderShiftID := uuid.NewString()
	gdb.Create(&models.CashShift{
		ID: outsiderShiftID, RestaurantID: &outsiderID, Status: &openStatus, OpenedAt: now,
		CashRevenue: decimal.MustFromString("999"), OrdersCount: intPtr(1),
	})

	svc := service.NewNetworkService(repo.New(gdb), "")
	owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), owner)

	// ─── Сводный список по сети ─────────────────────────────────────────────
	out, err := svc.Shifts(ctxCentral, service.PeriodFilter{}, "", "")
	if err != nil {
		t.Fatalf("Shifts: %v", err)
	}
	if len(out.Shifts) != 2 {
		t.Fatalf("Shifts вернул %d строк, want 2 (чужая сеть не должна попасть)", len(out.Shifts))
	}
	if out.Totals.OpenCount != 1 || out.Totals.ClosedCount != 1 {
		t.Errorf("Totals open/closed = %d/%d, want 1/1", out.Totals.OpenCount, out.Totals.ClosedCount)
	}
	if !out.Totals.Revenue.Equal(decimal.MustFromString("10000")) {
		t.Errorf("Totals.Revenue = %s, want 10000 (3000+2000+4000+1000)", out.Totals.Revenue.String())
	}
	if out.Totals.DiscrepancyCount != 1 {
		t.Errorf("DiscrepancyCount = %d, want 1", out.Totals.DiscrepancyCount)
	}
	// Новые сверху: открытая смена (opened_at ближе к now) должна идти первой.
	if out.Shifts[0].ID != openShiftID {
		t.Errorf("первая строка = %s, want открытую смену %s (ORDER BY opened_at DESC)", out.Shifts[0].ID, openShiftID)
	}
	for _, r := range out.Shifts {
		if r.RestaurantName != "Филиал" {
			t.Errorf("RestaurantName = %q, want 'Филиал'", r.RestaurantName)
		}
		if r.ID == closedShiftID {
			if r.Discrepancy == nil || !r.Discrepancy.Equal(decimal.MustFromString("-100")) {
				t.Errorf("Discrepancy = %v, want -100 (4900-5000)", r.Discrepancy)
			}
			if r.AccountName != "Касса филиала" {
				t.Errorf("AccountName = %q, want 'Касса филиала'", r.AccountName)
			}
			if r.OpenedByName != "Кассир Филиала" || r.ClosedByName != "Кассир Филиала" {
				t.Errorf("opened/closed by name не резолвились: %q / %q", r.OpenedByName, r.ClosedByName)
			}
		}
	}

	// ─── Фильтр по branch_id ────────────────────────────────────────────────
	byBranch, err := svc.Shifts(ctxCentral, service.PeriodFilter{}, branchID, "")
	if err != nil {
		t.Fatalf("Shifts(branchID): %v", err)
	}
	if len(byBranch.Shifts) != 2 {
		t.Errorf("Shifts(branchID) вернул %d строк, want 2", len(byBranch.Shifts))
	}
	if _, err := svc.Shifts(ctxCentral, service.PeriodFilter{}, outsiderID, ""); err == nil {
		t.Error("branch_id чужой сети должен быть отклонён")
	}

	// ─── Фильтр по status ───────────────────────────────────────────────────
	onlyOpen, err := svc.Shifts(ctxCentral, service.PeriodFilter{}, "", "open")
	if err != nil {
		t.Fatalf("Shifts(status=open): %v", err)
	}
	if len(onlyOpen.Shifts) != 1 || onlyOpen.Shifts[0].ID != openShiftID {
		t.Errorf("Shifts(status=open) = %+v, want ровно openShiftID", onlyOpen.Shifts)
	}

	// ─── Z-отчёт одной смены — делегирование с подменой tenant ─────────────
	z, err := svc.ShiftZReport(ctxCentral, closedShiftID)
	if err != nil {
		t.Fatalf("ShiftZReport: %v", err)
	}
	if !z.Shift.CashRevenue.Equal(decimal.MustFromString("4000")) {
		t.Errorf("ShiftZReport.Shift.CashRevenue = %s, want 4000", z.Shift.CashRevenue.String())
	}
	if _, err := svc.ShiftZReport(ctxCentral, outsiderShiftID); err == nil {
		t.Error("Z-отчёт чужой смены должен быть отклонён")
	}
}

func intPtr(n int) *int { return &n }
