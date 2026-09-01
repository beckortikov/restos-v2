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
)

// Недельный шаблон + переопределения по датам: план на дату = переопределение,
// если оно есть; иначе шаблон по дню недели; иначе строки нет вообще (пустой
// день — не отгул).
func TestSchedule_TemplateAndOverrides(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)
	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true}}`)))

	waiter, name := "waiter", "Сафар"
	userID := uuid.NewString()
	gdb.Create(&models.User{ID: userID, Name: &name, Role: &waiter, RestaurantID: &f.rid})

	// Пн-ср с 09:00. Заодно проверяем, что «9:0» нормализуется в «09:00» —
	// график заполняют руками, и терпимость к вводу тут уместна.
	r, b := f.put(t, "/api/v1/schedule/template", tok, uuid.NewString(), map[string]any{
		"user_id": userID,
		"slots": []map[string]any{
			{"weekday": 1, "starts_at": "9:0", "ends_at": "18:00"},
			{"weekday": 2, "starts_at": "09:00", "ends_at": "18:00"},
			{"weekday": 3, "starts_at": "09:00", "ends_at": "18:00"},
		},
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("set template: %d %s", r.StatusCode, b)
	}
	var tpl struct {
		Data []struct {
			Weekday  int    `json:"weekday"`
			StartsAt string `json:"starts_at"`
		} `json:"data"`
	}
	_ = json.Unmarshal(b, &tpl)
	if len(tpl.Data) != 3 || tpl.Data[0].StartsAt != "09:00" {
		t.Fatalf("шаблон: %+v", tpl.Data)
	}

	// 2026-09-07 — понедельник, 08 — вторник, 12 — суббота (вне шаблона).
	plan := func(from, to string) []map[string]any {
		q := url.Values{}
		q.Set("from", from)
		q.Set("to", to)
		r, b := f.get(t, "/api/v1/schedule?"+q.Encode(), tok)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("plan: %d %s", r.StatusCode, b)
		}
		var out struct {
			Data []map[string]any `json:"data"`
		}
		_ = json.Unmarshal(b, &out)
		return out.Data
	}

	rows := plan("2026-09-07", "2026-09-13")
	if len(rows) != 3 {
		t.Fatalf("ожидали 3 плановых дня (пн-ср), получили %d: %+v", len(rows), rows)
	}
	for _, row := range rows {
		if row["source"] != "template" {
			t.Fatalf("источник должен быть template: %+v", row)
		}
	}

	// Отгул во вторник — явный, а не «нет строки».
	r, b = f.put(t, "/api/v1/schedule/day", tok, uuid.NewString(), map[string]any{
		"user_id": userID, "date": "2026-09-08", "kind": "off", "note": "отгул",
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("set day off: %d %s", r.StatusCode, b)
	}
	// Разовая суббота — вопреки шаблону.
	r, b = f.put(t, "/api/v1/schedule/day", tok, uuid.NewString(), map[string]any{
		"user_id": userID, "date": "2026-09-12", "kind": "work",
		"starts_at": "14:00", "ends_at": "22:00",
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("set day work: %d %s", r.StatusCode, b)
	}

	rows = plan("2026-09-07", "2026-09-13")
	byDate := map[string]map[string]any{}
	for _, row := range rows {
		byDate[row["date"].(string)] = row
	}
	if byDate["2026-09-08"]["is_off"] != true || byDate["2026-09-08"]["source"] != "override" {
		t.Fatalf("вторник должен быть отгулом-override: %+v", byDate["2026-09-08"])
	}
	if byDate["2026-09-12"]["starts_at"] != "14:00" {
		t.Fatalf("суббота должна быть рабочей с 14:00: %+v", byDate["2026-09-12"])
	}

	// Снятие переопределения возвращает день к шаблону.
	q := url.Values{}
	q.Set("user_id", userID)
	q.Set("date", "2026-09-08")
	if r, b = f.del(t, "/api/v1/schedule/day?"+q.Encode(), tok, uuid.NewString()); r.StatusCode != http.StatusNoContent {
		t.Fatalf("delete day: %d %s", r.StatusCode, b)
	}
	rows = plan("2026-09-08", "2026-09-08")
	if len(rows) != 1 || rows[0]["source"] != "template" || rows[0]["is_off"] == true {
		t.Fatalf("после снятия отгула вторник должен вернуться к шаблону: %+v", rows)
	}

	// Замена шаблона снимает выпавшие дни: иначе снятая среда продолжала бы
	// требовать явки.
	r, b = f.put(t, "/api/v1/schedule/template", tok, uuid.NewString(), map[string]any{
		"user_id": userID,
		"slots":   []map[string]any{{"weekday": 1, "starts_at": "10:00", "ends_at": "19:00"}},
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("replace template: %d %s", r.StatusCode, b)
	}
	rows = plan("2026-09-07", "2026-09-11")
	if len(rows) != 1 || rows[0]["date"] != "2026-09-07" || rows[0]["starts_at"] != "10:00" {
		t.Fatalf("после замены должен остаться только понедельник 10:00: %+v", rows)
	}
}

// Перекличка: вовремя / опоздал / не пришёл / отметился без плана.
func TestSchedule_RollCall(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)
	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true}}`)))

	// Часовой пояс ресторана — тот, в котором составлен график; факт хранится
	// в UTC, и сравнение обязано идти через него.
	loc, err := time.LoadLocation("Asia/Dushanbe")
	if err != nil {
		t.Fatal(err)
	}
	gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).Update("timezone", "Asia/Dushanbe")

	mk := func(name string) string {
		role := "waiter"
		id := uuid.NewString()
		gdb.Create(&models.User{ID: id, Name: &name, Role: &role, RestaurantID: &f.rid})
		return id
	}
	punctual, late, absent, extra := mk("Пунктуальный"), mk("Опоздавший"), mk("Прогульщик"), mk("Подменщик")

	// 2026-09-07 — понедельник: троим ставим смену с 09:00, четвёртому ничего.
	for _, id := range []string{punctual, late, absent} {
		r, b := f.put(t, "/api/v1/schedule/template", tok, uuid.NewString(), map[string]any{
			"user_id": id,
			"slots":   []map[string]any{{"weekday": 1, "starts_at": "09:00", "ends_at": "18:00"}},
		})
		if r.StatusCode != http.StatusOK {
			t.Fatalf("template: %d %s", r.StatusCode, b)
		}
	}

	clockIn := func(userID string, hh, mm int) {
		at := time.Date(2026, 9, 7, hh, mm, 0, 0, loc).UTC()
		active := "active"
		src := "app"
		gdb.Create(&models.TimeEntry{
			ID: uuid.NewString(), UserID: &userID, ClockIn: &at,
			Status: &active, Source: &src, RestaurantID: &f.rid,
		})
	}
	clockIn(punctual, 8, 57) // раньше плана — не опоздание
	clockIn(late, 9, 32)     // +32 мин
	clockIn(extra, 12, 0)    // без плана вообще

	r, b := f.get(t, "/api/v1/schedule/roll-call?date=2026-09-07", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("roll-call: %d %s", r.StatusCode, b)
	}
	var rep struct {
		Planned   int `json:"planned"`
		Present   int `json:"present"`
		Late      int `json:"late"`
		Absent    int `json:"absent"`
		Unplanned int `json:"unplanned"`
		Rows      []struct {
			UserID      string `json:"user_id"`
			Status      string `json:"status"`
			LateMinutes int    `json:"late_minutes"`
		} `json:"rows"`
	}
	_ = json.Unmarshal(b, &rep)

	if rep.Planned != 3 || rep.Present != 2 || rep.Late != 1 || rep.Absent != 1 || rep.Unplanned != 1 {
		t.Fatalf("сводка переклички: %+v", rep)
	}
	byUser := map[string]string{}
	lateMin := 0
	for _, row := range rep.Rows {
		byUser[row.UserID] = row.Status
		if row.UserID == late {
			lateMin = row.LateMinutes
		}
	}
	if byUser[punctual] != "on_time" {
		t.Fatalf("пришедший в 08:57 не должен быть опоздавшим: %s", byUser[punctual])
	}
	if byUser[late] != "late" || lateMin != 32 {
		t.Fatalf("опоздание должно быть 32 мин, получили %s/%d", byUser[late], lateMin)
	}
	if byUser[absent] != "absent" {
		t.Fatalf("не пришедший должен быть absent: %s", byUser[absent])
	}
	if byUser[extra] != "unplanned" {
		t.Fatalf("вышедший без графика должен быть unplanned: %s", byUser[extra])
	}
}
