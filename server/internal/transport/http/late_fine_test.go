//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Штраф за опоздание (105): сумма считается по политике ресторана,
// выставляется явным действием и ровно один раз за день.
func TestLateFine_SuggestedAndAppliedOnce(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)
	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true}}`)))

	loc, err := time.LoadLocation("Asia/Dushanbe")
	if err != nil {
		t.Fatal(err)
	}
	// Политика: 10 фикс + 2 за минуту сверх грейса 5, потолок 100.
	gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).Updates(map[string]any{
		"timezone":             "Asia/Dushanbe",
		"late_grace_minutes":   5,
		"late_fine_fixed":      decimal.MustFromString("10"),
		"late_fine_per_minute": decimal.MustFromString("2"),
		"late_fine_max":        decimal.MustFromString("100"),
	})

	waiter, name := "waiter", "Опоздавший"
	userID := uuid.NewString()
	gdb.Create(&models.User{ID: userID, Name: &name, Role: &waiter, RestaurantID: &f.rid})

	// Понедельник 2026-09-07, смена с 09:00.
	r, b := f.put(t, "/api/v1/schedule/template", tok, uuid.NewString(), map[string]any{
		"user_id": userID,
		"slots":   []map[string]any{{"weekday": 1, "starts_at": "09:00", "ends_at": "18:00"}},
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("template: %d %s", r.StatusCode, b)
	}
	at := time.Date(2026, 9, 7, 9, 35, 0, 0, loc).UTC() // +35 мин
	active := "active"
	gdb.Create(&models.TimeEntry{
		ID: uuid.NewString(), UserID: &userID, ClockIn: &at, Status: &active, RestaurantID: &f.rid,
	})

	rollCall := func() map[string]any {
		r, b := f.get(t, "/api/v1/schedule/roll-call?date=2026-09-07", tok)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("roll-call: %d %s", r.StatusCode, b)
		}
		var rep struct {
			FinesConfigured bool             `json:"fines_configured"`
			GraceMinutes    int              `json:"grace_minutes"`
			Rows            []map[string]any `json:"rows"`
		}
		_ = json.Unmarshal(b, &rep)
		if !rep.FinesConfigured || rep.GraceMinutes != 5 {
			t.Fatalf("политика не доехала в отчёт: %+v", rep)
		}
		for _, row := range rep.Rows {
			if row["user_id"] == userID {
				return row
			}
		}
		t.Fatalf("строка сотрудника не найдена: %+v", rep.Rows)
		return nil
	}

	// 10 + 2 × (35 − 5) = 70.
	row := rollCall()
	if row["status"] != "late" || row["suggested_fine"] != "70" {
		t.Fatalf("предложенный штраф: %+v", row)
	}
	if row["fined"] == true {
		t.Fatalf("штраф ещё не выставлялся: %+v", row)
	}

	// Выставляем — сумма берётся серверная, а не из тела запроса.
	r, b = f.post(t, "/api/v1/schedule/roll-call/fine", tok, uuid.NewString(), map[string]any{
		"user_id": userID, "date": "2026-09-07",
	})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("fine: %d %s", r.StatusCode, b)
	}
	var ded models.SalaryDeduction
	if err := gdb.Where("user_id = ? AND cancelled_at IS NULL", userID).First(&ded).Error; err != nil {
		t.Fatalf("удержание не создано: %v", err)
	}
	if ded.Amount.String() != "70" {
		t.Fatalf("сумма удержания = %s, want 70", ded.Amount.String())
	}
	if ded.SourceRef == nil || *ded.SourceRef != "late:"+userID+":2026-09-07" {
		t.Fatalf("source_ref = %v", ded.SourceRef)
	}
	if ded.Period == nil || *ded.Period != "2026-09" {
		t.Fatalf("period = %v, want 2026-09", ded.Period)
	}
	// users.deductions — денормализованный счётчик, который читает начисление.
	var u models.User
	gdb.Where("id = ?", userID).First(&u)
	if u.Deductions.String() != "70" {
		t.Fatalf("users.deductions = %s, want 70", u.Deductions.String())
	}

	// Перекличка теперь знает, что штраф выставлен — кнопка на экране гаснет.
	if row = rollCall(); row["fined"] != true {
		t.Fatalf("после штрафа fined должен быть true: %+v", row)
	}

	// Повтор — конфликт, а не второе удержание: два менеджера, открывшие
	// перекличку одновременно, иначе списали бы дважды.
	r, b = f.post(t, "/api/v1/schedule/roll-call/fine", tok, uuid.NewString(), map[string]any{
		"user_id": userID, "date": "2026-09-07",
	})
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("повторный штраф: ожидали 409, получили %d %s", r.StatusCode, b)
	}
	var n int64
	gdb.Model(&models.SalaryDeduction{}).Where("user_id = ?", userID).Count(&n)
	if n != 1 {
		t.Fatalf("удержаний стало %d, want 1", n)
	}
}

// Без заданных правил перекличка показывает опоздание, но штрафовать не даёт:
// «0 сомони» на экране выглядело бы как настроенный нулевой штраф.
func TestLateFine_NotOfferedWithoutPolicy(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)
	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true}}`)))

	loc, _ := time.LoadLocation("Asia/Dushanbe")
	gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).Update("timezone", "Asia/Dushanbe")

	cook, name := "cook", "Тоже опоздал"
	userID := uuid.NewString()
	gdb.Create(&models.User{ID: userID, Name: &name, Role: &cook, RestaurantID: &f.rid})

	f.put(t, "/api/v1/schedule/template", tok, uuid.NewString(), map[string]any{
		"user_id": userID,
		"slots":   []map[string]any{{"weekday": 1, "starts_at": "09:00", "ends_at": "18:00"}},
	})
	at := time.Date(2026, 9, 7, 10, 0, 0, 0, loc).UTC()
	active := "active"
	gdb.Create(&models.TimeEntry{
		ID: uuid.NewString(), UserID: &userID, ClockIn: &at, Status: &active, RestaurantID: &f.rid,
	})

	r, b := f.get(t, "/api/v1/schedule/roll-call?date=2026-09-07", tok)
	var rep struct {
		FinesConfigured bool             `json:"fines_configured"`
		Rows            []map[string]any `json:"rows"`
	}
	_ = json.Unmarshal(b, &rep)
	if r.StatusCode != http.StatusOK || rep.FinesConfigured {
		t.Fatalf("правил нет — fines_configured должен быть false: %d %+v", r.StatusCode, rep)
	}
	for _, row := range rep.Rows {
		if row["user_id"] == userID {
			if row["status"] != "late" {
				t.Fatalf("опоздание должно фиксироваться и без правил: %+v", row)
			}
			if row["suggested_fine"] != nil {
				t.Fatalf("без правил суммы быть не должно: %+v", row)
			}
		}
	}

	r, b = f.post(t, "/api/v1/schedule/roll-call/fine", tok, uuid.NewString(), map[string]any{
		"user_id": userID, "date": "2026-09-07",
	})
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("штраф без правил: ожидали 400, получили %d %s", r.StatusCode, b)
	}
}

// Политика опозданий должна сохраняться через тот эндпоинт, которым её правит
// фронт — PATCH /restaurants/{id}. Поля, добавленные только в соседний
// RestaurantInput (/restaurant), молча не сохранялись: PATCH отвечал 200, а
// значения оставались нулевыми, и перекличка не предлагала штрафов.
func TestLateFine_PolicySavedViaRestaurantsPatch(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)
	gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true,"users.manage":true}}`)))

	r, b := f.patch(t, "/api/v1/restaurants/"+f.rid, tok, uuid.NewString(), map[string]any{
		"late_grace_minutes":   7,
		"late_fine_fixed":      "10",
		"late_fine_per_minute": "2",
		"late_fine_max":        "100",
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("patch: %d %s", r.StatusCode, b)
	}

	var rest models.Restaurant
	if err := gdb.Where("id = ?", f.rid).First(&rest).Error; err != nil {
		t.Fatal(err)
	}
	if rest.LateGraceMinutes != 7 {
		t.Fatalf("late_grace_minutes = %d, want 7", rest.LateGraceMinutes)
	}
	if rest.LateFineFixed.String() != "10" || rest.LateFinePerMinute.String() != "2" || rest.LateFineMax.String() != "100" {
		t.Fatalf("суммы политики не сохранились: %s / %s / %s",
			rest.LateFineFixed.String(), rest.LateFinePerMinute.String(), rest.LateFineMax.String())
	}

	// И перекличка сразу видит новую политику — иначе экран продолжал бы
	// говорить «штрафы не настроены» после успешного сохранения.
	r, b = f.get(t, "/api/v1/schedule/roll-call?date=2026-09-07", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("roll-call: %d %s", r.StatusCode, b)
	}
	var rep struct {
		GraceMinutes    int  `json:"grace_minutes"`
		FinesConfigured bool `json:"fines_configured"`
	}
	_ = json.Unmarshal(b, &rep)
	if rep.GraceMinutes != 7 || !rep.FinesConfigured {
		t.Fatalf("перекличка не увидела политику: %+v", rep)
	}
}
