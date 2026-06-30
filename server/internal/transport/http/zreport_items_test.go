//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Z-отчёт смены должен показывать проданные блюда/товары (что и сколько продано).
func TestZReport_SalesByItem(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	shiftID := uuid.NewString()
	open := "open"
	if err := gdb.Create(&models.CashShift{ID: shiftID, Status: &open, OpenedAt: time.Now(), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	closed := "closed"
	now := time.Now()
	oID := uuid.NewString()
	if err := gdb.Create(&models.Order{ID: oID, Status: &closed, ClosedAt: &now, ShiftID: &shiftID, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	mk := func(name, qty, price string) {
		miID, n := uuid.NewString(), name
		if err := gdb.Create(&models.MenuItem{ID: miID, Name: &n, Price: decimal.MustFromString(price), RestaurantID: &f.rid}).Error; err != nil {
			t.Fatal(err)
		}
		if err := gdb.Create(&models.OrderItem{
			ID: uuid.NewString(), OrderID: &oID, MenuItemID: &miID, Name: &n,
			Qty: decimal.MustFromString(qty), Price: decimal.MustFromString(price),
		}).Error; err != nil {
			t.Fatal(err)
		}
	}
	mk("Плов", "2", "30") // total 60
	mk("Чай", "3", "10")  // total 30

	resp, b := f.get(t, "/api/v1/shifts/"+shiftID+"/zreport", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("zreport: %d %s", resp.StatusCode, b)
	}
	var rep struct {
		SalesByItem []struct {
			Name  string          `json:"name"`
			Qty   decimal.Decimal `json:"qty"`
			Total decimal.Decimal `json:"total"`
		} `json:"sales_by_item"`
	}
	if err := json.Unmarshal(b, &rep); err != nil {
		t.Fatal(err)
	}
	byName := map[string][2]string{}
	for _, it := range rep.SalesByItem {
		byName[it.Name] = [2]string{decimal.Normalize(it.Qty).String(), decimal.Normalize(it.Total).String()}
	}
	if got, ok := byName["Плов"]; !ok || got[0] != "2" || got[1] != "60" {
		t.Fatalf("ожидали Плов ×2 = 60, получили %v (всё: %+v)", got, byName)
	}
	if got, ok := byName["Чай"]; !ok || got[0] != "3" || got[1] != "30" {
		t.Fatalf("ожидали Чай ×3 = 30, получили %v (всё: %+v)", got, byName)
	}
}
