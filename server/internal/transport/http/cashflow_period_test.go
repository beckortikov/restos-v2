//go:build integration

package http_test

import (
	"encoding/json"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Баг: ДДС (и P&L) показывали 0, пока за период есть только СЕГОДНЯШНИЕ операции.
// Причина: date-only `to` (напр. "сегодня") парсился как полночь, а фильтр
// created_at < to отсекал весь день `to`. Фикс: date-only `to` инклюзивен (+1 день).
func TestCashflow_IncludesTodayOps(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	now := time.Now().UTC()
	today := now.Format("2006-01-02")
	inType, act, cat := "in", "operational", "revenue"
	op := &models.FinancialOperation{
		ID: uuid.NewString(), Type: &inType, Activity: &act, Category: &cat,
		Amount: decimal.MustFromString("100"), Date: &today,
		RestaurantID: &f.rid, CreatedAt: now, UpdatedAt: now,
	}
	if err := gdb.Create(op).Error; err != nil {
		t.Fatal(err)
	}

	// Период «сегодня..сегодня» (date-only, как шлёт фронт по пресету).
	resp, b := f.get(t, "/api/v1/finance/cashflow?from="+today+"&to="+today, tok)
	if resp.StatusCode != 200 {
		t.Fatalf("cashflow: %d %s", resp.StatusCode, b)
	}
	var out struct {
		NetTotal   decimal.Decimal `json:"net_total"`
		ByActivity map[string]struct {
			In decimal.Decimal `json:"in"`
		} `json:"by_activity"`
	}
	if err := json.Unmarshal(b, &out); err != nil {
		t.Fatal(err)
	}
	if !out.NetTotal.Equal(decimal.MustFromString("100")) {
		t.Fatalf("ДДС с to=сегодня должен включать сегодняшнюю операцию: net=%s, ожидали 100 (resp: %s)",
			decimal.Normalize(out.NetTotal).String(), b)
	}
	if !out.ByActivity["operational"].In.Equal(decimal.MustFromString("100")) {
		t.Fatalf("operational.in=%s, ожидали 100", decimal.Normalize(out.ByActivity["operational"].In).String())
	}
}
