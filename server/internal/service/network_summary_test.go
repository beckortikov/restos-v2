//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestNetworkSummary — сводка владельцу: выручка по сети и по филиалам
// (ADR-003, Фаза 4). Считается из financial_operations(type=in, category=revenue),
// прочие операции не учитываются.
func TestNetworkSummary(t *testing.T) {
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
	for _, tbl := range []string{"financial_operations", "restaurants", "company_accounts"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	if err := gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"}).Error; err != nil {
		t.Fatal(err)
	}
	centralID, outletID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Склад", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: outletID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	rev, in := "revenue", "in"
	out, purchase := "out", "stock_purchase"
	mk := func(rid string, typ, cat *string, amt string) {
		if err := gdb.Create(&models.FinancialOperation{
			ID: uuid.NewString(), Type: typ, Category: cat,
			Amount: decimal.MustFromString(amt), RestaurantID: &rid,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	mk(centralID, &in, &rev, "100")     // учитывается
	mk(centralID, &out, &purchase, "999") // НЕ выручка → не учитывается
	mk(outletID, &in, &rev, "50")       // учитывается

	svc := service.NewNetworkService(repo.New(gdb))
	ctx := tenant.WithRestaurant(context.Background(), centralID)

	sum, err := svc.Summary(ctx, "", "")
	if err != nil {
		t.Fatalf("Summary: %v", err)
	}
	if !sum.TotalRevenue.Equal(decimal.MustFromString("150")) {
		t.Errorf("total revenue = %s, want 150", sum.TotalRevenue.String())
	}
	if len(sum.Branches) != 2 {
		t.Fatalf("branches = %d, want 2", len(sum.Branches))
	}
	byID := map[string]decimal.Decimal{}
	for _, b := range sum.Branches {
		byID[b.ID] = b.Revenue
	}
	if !byID[centralID].Equal(decimal.MustFromString("100")) {
		t.Errorf("central revenue = %s, want 100", byID[centralID].String())
	}
	if !byID[outletID].Equal(decimal.MustFromString("50")) {
		t.Errorf("outlet revenue = %s, want 50", byID[outletID].String())
	}
}
