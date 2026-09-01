//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// loginAsPIN — вход произвольной учёткой ресторана (f.login ходит только под
// фикстурным кассиром, а терминалу нужна СВОЯ служебная учётка с ролью
// checkin: именно её токен лежит на планшете у входа).
func loginAsPIN(t *testing.T, f *e2eFixture, pin string) string {
	t.Helper()
	body, _ := json.Marshal(map[string]string{"restaurant_id": f.rid, "pin": pin})
	resp, err := http.Post(f.srv.URL+"/api/v1/auth/login", "application/json", bytes.NewReader(body))
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != http.StatusOK {
		b, _ := io.ReadAll(resp.Body)
		t.Fatalf("login pin=%s: %d %s", pin, resp.StatusCode, b)
	}
	var out struct {
		Token string `json:"token"`
	}
	_ = json.NewDecoder(resp.Body).Decode(&out)
	return out.Token
}

// seedTerminal — служебная учётка терминала + её токен.
func seedTerminal(t *testing.T, f *e2eFixture, gdb *gorm.DB, pin string) string {
	t.Helper()
	role, name := "checkin", "Терминал у входа"
	if err := gdb.Create(&models.User{
		ID: uuid.NewString(), Name: &name, Role: &role, PIN: &pin, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	return loginAsPIN(t, f, pin)
}

// Терминал учёта времени (:checkin): полный цикл отметки — приход, повторный
// приход как конфликт, уход, и брошенная вчерашняя смена, которая не должна
// блокировать сегодняшний приход.
func TestAttendance_PunchCycle(t *testing.T) {
	f := setupE2E(t)
	gdb := openTestDB(t)
	tok := seedTerminal(t, f, gdb, "1111")

	waiter, name, pin := "waiter", "Далер", "7788"
	userID := uuid.NewString()
	gdb.Create(&models.User{
		ID: userID, Name: &name, Role: &waiter, PIN: &pin, RestaurantID: &f.rid,
	})

	lookup := func(pin string) (*http.Response, map[string]any) {
		r, b := f.post(t, "/api/v1/attendance/lookup", tok, uuid.NewString(), map[string]any{"pin": pin})
		var out map[string]any
		_ = json.Unmarshal(b, &out)
		return r, out
	}
	punch := func(pin, action string) (*http.Response, map[string]any) {
		r, b := f.post(t, "/api/v1/attendance/punch", tok, uuid.NewString(), map[string]any{
			"pin": pin, "action": action,
		})
		var out map[string]any
		_ = json.Unmarshal(b, &out)
		return r, out
	}

	// 1. До первой отметки терминал предлагает приход.
	r, out := lookup(pin)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("lookup: %d %v", r.StatusCode, out)
	}
	if out["next_action"] != "in" || out["user_name"] != name {
		t.Fatalf("lookup: ожидали in/%s, получили %v", name, out)
	}

	// 2. Приход создаёт запись табеля с source='app' — отметка сотрудника
	//    отличается от ручной проставленной менеджером.
	r, out = punch(pin, "in")
	if r.StatusCode != http.StatusOK || out["action"] != "in" {
		t.Fatalf("punch in: %d %v", r.StatusCode, out)
	}
	entryID, _ := out["entry_id"].(string)
	var entry models.TimeEntry
	if err := gdb.Where("id = ?", entryID).First(&entry).Error; err != nil {
		t.Fatalf("запись табеля не создана: %v", err)
	}
	if entry.Source == nil || *entry.Source != "app" {
		t.Fatalf("source: ожидали app, получили %v", entry.Source)
	}
	if entry.ClockOut != nil {
		t.Fatalf("смена должна быть открытой")
	}

	// 3. Второй приход подряд — конфликт, а не вторая открытая смена
	//    (двойной тап по кнопке не должен раздваивать табель).
	r, out = punch(pin, "in")
	if r.StatusCode != http.StatusConflict {
		t.Fatalf("повторный приход: ожидали 409, получили %d %v", r.StatusCode, out)
	}

	// 4. Теперь терминал предлагает уход.
	if _, out = lookup(pin); out["next_action"] != "out" {
		t.Fatalf("lookup после прихода: ожидали out, получили %v", out)
	}

	// 5. «Кто на смене» видит сотрудника по имени.
	r, b := f.get(t, "/api/v1/attendance/on-shift", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("on-shift: %d %s", r.StatusCode, b)
	}
	var shift struct {
		Data []struct {
			UserID   string `json:"user_id"`
			UserName string `json:"user_name"`
		} `json:"data"`
	}
	_ = json.Unmarshal(b, &shift)
	if len(shift.Data) != 1 || shift.Data[0].UserID != userID || shift.Data[0].UserName != name {
		t.Fatalf("on-shift: ожидали одного %s, получили %+v", name, shift.Data)
	}

	// 6. Уход закрывает ту же запись.
	r, out = punch(pin, "out")
	if r.StatusCode != http.StatusOK || out["action"] != "out" {
		t.Fatalf("punch out: %d %v", r.StatusCode, out)
	}
	gdb.Where("id = ?", entryID).First(&entry)
	if entry.ClockOut == nil || entry.Status == nil || *entry.Status != "closed" {
		t.Fatalf("смена не закрыта: %+v", entry)
	}

	// 7. Уход без прихода — конфликт.
	if r, out = punch(pin, "out"); r.StatusCode != http.StatusConflict {
		t.Fatalf("уход без прихода: ожидали 409, получили %d %v", r.StatusCode, out)
	}
}

// Забытый вчера уход не должен блокировать сегодняшний приход: сервер закрывает
// брошенную смену нулевой длительностью (время ухода мы не знаем — выдумывать
// его нельзя) и открывает новую, сообщив об этом терминалу.
func TestAttendance_StaleShiftDoesNotBlockNextDay(t *testing.T) {
	f := setupE2E(t)
	gdb := openTestDB(t)
	tok := seedTerminal(t, f, gdb, "1111")

	cook, name, pin := "cook", "Забывчивый", "4321"
	userID := uuid.NewString()
	gdb.Create(&models.User{ID: userID, Name: &name, Role: &cook, PIN: &pin, RestaurantID: &f.rid})

	// Вчерашняя смена, открытая 20 часов назад.
	staleID := uuid.NewString()
	yesterday := time.Now().UTC().Add(-20 * time.Hour)
	active := "active"
	gdb.Create(&models.TimeEntry{
		ID: staleID, UserID: &userID, ClockIn: &yesterday, Status: &active, RestaurantID: &f.rid,
	})

	// Терминал предлагает приход, а не уход: вчерашняя смена уже не считается
	// текущей.
	r, b := f.post(t, "/api/v1/attendance/lookup", tok, uuid.NewString(), map[string]any{"pin": pin})
	var look map[string]any
	_ = json.Unmarshal(b, &look)
	if r.StatusCode != http.StatusOK || look["next_action"] != "in" {
		t.Fatalf("lookup при брошенной смене: %d %v", r.StatusCode, look)
	}

	r, b = f.post(t, "/api/v1/attendance/punch", tok, uuid.NewString(), map[string]any{
		"pin": pin, "action": "in",
	})
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("punch in при брошенной смене: %d %v", r.StatusCode, out)
	}
	if out["closed_stale_entry_id"] != staleID {
		t.Fatalf("брошенная смена не закрыта: %v", out)
	}

	var stale models.TimeEntry
	gdb.Where("id = ?", staleID).First(&stale)
	if stale.ClockOut == nil || stale.Status == nil || *stale.Status != "closed" {
		t.Fatalf("брошенная смена осталась открытой: %+v", stale)
	}
	// Часы не выдуманы: закрыта временем собственного прихода.
	if !stale.TotalHours.IsZero() {
		t.Fatalf("брошенной смене приписали часы: %s", stale.TotalHours.String())
	}
	if stale.Note == nil || *stale.Note == "" {
		t.Fatalf("нет пометки о незакрытой смене: %+v", stale)
	}

	// Новая смена открыта и она не та же самая.
	newID, _ := out["entry_id"].(string)
	if newID == staleID || newID == "" {
		t.Fatalf("новая смена не открыта: %v", out)
	}
}

// PIN самого терминала, незнакомый PIN и чужой токен отметку не создают:
// иначе табель наполнялся бы сменами служебной учётки, подбор четырёх цифр
// давал бы чужие приходы, а отмечать людей мог бы любой планшет в сети.
func TestAttendance_RejectsTerminalPINUnknownPINAndForeignToken(t *testing.T) {
	f := setupE2E(t)
	gdb := openTestDB(t)
	terminalPIN := "1111"
	tok := seedTerminal(t, f, gdb, terminalPIN)

	r, _ := f.post(t, "/api/v1/attendance/punch", tok, uuid.NewString(), map[string]any{
		"pin": terminalPIN, "action": "in",
	})
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("PIN терминала: ожидали 403, получили %d", r.StatusCode)
	}

	r, _ = f.post(t, "/api/v1/attendance/lookup", tok, uuid.NewString(), map[string]any{"pin": "0000"})
	if r.StatusCode != http.StatusUnauthorized {
		t.Fatalf("незнакомый PIN: ожидали 401, получили %d", r.StatusCode)
	}

	// Токен обычного сотрудника (фикстурный кассир) — не терминал: с кассы или
	// с телефона официанта отметки не принимаются.
	r, _ = f.post(t, "/api/v1/attendance/lookup", f.login(t), uuid.NewString(), map[string]any{
		"pin": terminalPIN,
	})
	if r.StatusCode != http.StatusForbidden {
		t.Fatalf("токен кассира: ожидали 403, получили %d", r.StatusCode)
	}

	var n int64
	gdb.Model(&models.TimeEntry{}).Where("restaurant_id = ?", f.rid).Count(&n)
	if n != 0 {
		t.Fatalf("отклонённые запросы создали %d записей табеля", n)
	}
}
