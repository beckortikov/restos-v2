//go:build integration

package http_test

import (
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Печать чека «Обслуживание официантов» за смену: эндпоинт ставит print_job
// type='service_report' и возвращает job_id.
func TestShiftPrintService(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	// Официант + смена + закрытый заказ с service_amount.
	waiterID, wname, role := uuid.NewString(), "Иван", "waiter"
	if err := gdb.Create(&models.User{ID: waiterID, Name: &wname, Role: &role, RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	shiftID, open := uuid.NewString(), "open"
	if err := gdb.Create(&models.CashShift{ID: shiftID, Status: &open, OpenedAt: time.Now(), RestaurantID: &f.rid}).Error; err != nil {
		t.Fatal(err)
	}
	closed, now := "closed", time.Now()
	if err := gdb.Create(&models.Order{
		ID: uuid.NewString(), Status: &closed, ClosedAt: &now, ShiftID: &shiftID,
		WaiterID: &waiterID, ServiceAmount: decimal.MustFromString("50"), RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.post(t, "/api/v1/shifts/"+shiftID+"/print-service", tok, uuid.NewString(), map[string]any{})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("print-service: %d %s", r.StatusCode, b)
	}

	var jobs []models.PrintJob
	gdb.Where("restaurant_id = ? AND type = ?", f.rid, "service_report").Find(&jobs)
	if len(jobs) == 0 {
		t.Fatalf("ожидали print_job type=service_report, не нашли")
	}
	if len(jobs[0].Payload) == 0 {
		t.Fatalf("payload чека пустой")
	}
}
