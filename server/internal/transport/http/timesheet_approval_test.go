//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Утверждение периода фиксирует сумму: правка отметок задним числом больше не
// меняет её молча, а показывается расхождением.
func TestTimesheetApproval_FreezesAndShowsDrift(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)
	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true}}`)))

	daily, cook, name := "daily", "cook", "Дневник"
	userID := uuid.NewString()
	gdb.Create(&models.User{
		ID: userID, Name: &name, Role: &cook, RestaurantID: &f.rid,
		PayType: &daily, DailyRate: decimal.MustFromString("100"),
	})

	// Две смены по 8 часов в июле.
	closed := "closed"
	for _, day := range []string{"2026-07-06", "2026-07-07"} {
		in, _ := time.Parse(time.RFC3339, day+"T09:00:00Z")
		out := in.Add(8 * time.Hour)
		gdb.Create(&models.TimeEntry{
			ID: uuid.NewString(), UserID: &userID, ClockIn: &in, ClockOut: &out,
			TotalHours: decimal.MustFromString("8"), Status: &closed, RestaurantID: &f.rid,
		})
	}

	status := func() map[string]any {
		q := url.Values{}
		q.Set("from", "2026-07-01")
		q.Set("to", "2026-07-31")
		r, b := f.get(t, "/api/v1/timesheet/approval?"+q.Encode(), tok)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("status: %d %s", r.StatusCode, b)
		}
		var out map[string]any
		_ = json.Unmarshal(b, &out)
		return out
	}

	// До утверждения — период открыт.
	if st := status(); st["approved"] != false {
		t.Fatalf("период не должен быть утверждён: %v", st["approved"])
	}

	// Утверждаем: 2 дня × 100 = 200.
	r, b := f.post(t, "/api/v1/timesheet/approval", tok, uuid.NewString(), map[string]any{
		"from": "2026-07-01", "to": "2026-07-31",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("approve: %d %s", r.StatusCode, b)
	}
	var approved models.TimesheetApproval
	if err := gdb.Where("user_id = ? AND cancelled_at IS NULL", userID).First(&approved).Error; err != nil {
		t.Fatalf("снимок не создан: %v", err)
	}
	if approved.Days != 2 || approved.Accrued.String() != "200" {
		t.Fatalf("снимок: дни=%d начислено=%s, want 2/200", approved.Days, approved.Accrued.String())
	}
	if approved.Hours.String() != "16" {
		t.Fatalf("часы в снимке = %s, want 16", approved.Hours.String())
	}

	// Повторное утверждение отклоняется: пересогласование идёт только через
	// переоткрытие, чтобы в истории остался след.
	r, _ = f.post(t, "/api/v1/timesheet/approval", tok, uuid.NewString(), map[string]any{
		"from": "2026-07-01", "to": "2026-07-31",
	})
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("повторное утверждение: ожидали 409, получили %d", r.StatusCode)
	}

	// Правим табель задним числом — добавляем третий день.
	in, _ := time.Parse(time.RFC3339, "2026-07-08T09:00:00Z")
	out := in.Add(8 * time.Hour)
	gdb.Create(&models.TimeEntry{
		ID: uuid.NewString(), UserID: &userID, ClockIn: &in, ClockOut: &out,
		TotalHours: decimal.MustFromString("8"), Status: &closed, RestaurantID: &f.rid,
	})

	st := status()
	if st["approved"] != true {
		t.Fatalf("период должен остаться утверждённым")
	}
	if int(st["changed_count"].(float64)) != 1 {
		t.Fatalf("расхождение не замечено: %v", st["changed_count"])
	}
	// Утверждённая сумма НЕ поехала за правкой — в этом весь смысл.
	if st["total_accrued"] != "200" {
		t.Fatalf("утверждённая сумма = %v, want 200", st["total_accrued"])
	}
	// Ищем строку по сотруднику: в сводке есть и те, кто в периоде не работал.
	var row map[string]any
	for _, raw := range st["rows"].([]any) {
		if r := raw.(map[string]any); r["user_id"] == userID {
			row = r
		}
	}
	if row == nil {
		t.Fatalf("сотрудника нет в сводке: %v", st["rows"])
	}
	if row["approved_days"].(float64) != 2 || row["current_days"].(float64) != 3 {
		t.Fatalf("строка расхождения: %v", row)
	}
	if row["changed"] != true {
		t.Fatalf("строка должна быть помечена изменённой: %v", row)
	}

	// Переоткрытие снимает утверждение и позволяет утвердить заново.
	r, b = f.post(t, "/api/v1/timesheet/approval/cancel", tok, uuid.NewString(), map[string]any{
		"from": "2026-07-01", "to": "2026-07-31",
	})
	if r.StatusCode != http.StatusNoContent {
		t.Fatalf("cancel: %d %s", r.StatusCode, b)
	}
	if st := status(); st["approved"] != false {
		t.Fatalf("после переоткрытия период должен быть открыт")
	}
	// Снятая строка остаётся в истории: кто и когда снял — важнее факта снятия.
	var cancelled int64
	gdb.Model(&models.TimesheetApproval{}).Where("user_id = ? AND cancelled_at IS NOT NULL", userID).Count(&cancelled)
	if cancelled != 1 {
		t.Fatalf("снятое утверждение должно остаться в истории, найдено %d", cancelled)
	}

	r, b = f.post(t, "/api/v1/timesheet/approval", tok, uuid.NewString(), map[string]any{
		"from": "2026-07-01", "to": "2026-07-31",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("повторное утверждение после переоткрытия: %d %s", r.StatusCode, b)
	}
	if st := status(); st["total_accrued"] != "300" {
		t.Fatalf("после пересогласования сумма = %v, want 300", st["total_accrued"])
	}
}
