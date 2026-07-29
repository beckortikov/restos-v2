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

// Баг: ДДС считал операции по created_at (дню ВВОДА), а не по date (деловой
// дате). Операция «задним числом» (date=5 дней назад, введена сегодня) попадала
// в сегодняшний день/период — график не сходился с таблицей (клиент фильтрует по
// date). Фикс: фильтр периода и by_day по деловой дате (foBizDay).
func TestCashflow_BucketsByBusinessDate(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if s, e := gdb.DB(); e == nil {
			_ = s.Close()
		}
	})

	now := time.Now().UTC()
	bizDay := now.AddDate(0, 0, -5).Format("2006-01-02") // деловая дата — 5 дней назад
	today := now.Format("2006-01-02")
	outType, act, cat := "out", "operational", "Аренда"
	op := &models.FinancialOperation{
		ID: uuid.NewString(), Type: &outType, Activity: &act, Category: &cat,
		Amount: decimal.MustFromString("500"), Date: &bizDay, // ← задним числом
		RestaurantID: &f.rid, CreatedAt: now, UpdatedAt: now, // введена сегодня
	}
	if err := gdb.Create(op).Error; err != nil {
		t.Fatal(err)
	}

	type cf struct {
		ByDay []struct {
			Date string          `json:"date"`
			Out  decimal.Decimal `json:"out"`
		} `json:"by_day"`
		ByActivity map[string]struct {
			Out decimal.Decimal `json:"out"`
		} `json:"by_activity"`
	}

	// 1) Период 7 дней назад..сегодня — операция ЕСТЬ, и в by_day она на своей
	//    деловой дате, а не на дне ввода.
	from := now.AddDate(0, 0, -7).Format("2006-01-02")
	resp, b := f.get(t, "/api/v1/finance/cashflow?from="+from+"&to="+today, tok)
	if resp.StatusCode != 200 {
		t.Fatalf("cashflow: %d %s", resp.StatusCode, b)
	}
	var wide cf
	if err := json.Unmarshal(b, &wide); err != nil {
		t.Fatal(err)
	}
	if !wide.ByActivity["operational"].Out.Equal(decimal.MustFromString("500")) {
		t.Fatalf("операция должна попасть в период по деловой дате: out=%s, ожидали 500", decimal.Normalize(wide.ByActivity["operational"].Out))
	}
	foundOnBizDay := false
	for _, d := range wide.ByDay {
		if d.Date == bizDay && d.Out.Equal(decimal.MustFromString("500")) {
			foundOnBizDay = true
		}
		if d.Date == today && d.Out.IsPositive() {
			t.Errorf("by_day: операция ошибочно стоит на дне ВВОДА (%s), а не на деловой дате %s", today, bizDay)
		}
	}
	if !foundOnBizDay {
		t.Fatalf("by_day: операции нет на её деловой дате %s: %s", bizDay, b)
	}

	// 2) Период только «сегодня» — операции задним числом НЕТ (её деловая дата в прошлом).
	resp2, b2 := f.get(t, "/api/v1/finance/cashflow?from="+today+"&to="+today, tok)
	if resp2.StatusCode != 200 {
		t.Fatalf("cashflow today: %d %s", resp2.StatusCode, b2)
	}
	var todayCf cf
	if err := json.Unmarshal(b2, &todayCf); err != nil {
		t.Fatal(err)
	}
	if todayCf.ByActivity["operational"].Out.IsPositive() {
		t.Errorf("операция с деловой датой в прошлом не должна попадать в период «сегодня»: out=%s", decimal.Normalize(todayCf.ByActivity["operational"].Out))
	}
}
