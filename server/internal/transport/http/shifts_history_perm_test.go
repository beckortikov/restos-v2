//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
)

// Право shifts.history: без него (кассир) список смен клампится к сегодняшнему
// дню; с правом (владелец/менеджер) видны смены всех дней.
func TestShifts_HistoryPermissionClampsToToday(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	closed := "closed"
	today := time.Now().Add(-2 * time.Hour) // сегодня
	old := time.Now().AddDate(0, 0, -5)     // 5 дней назад
	for _, when := range []time.Time{today, old} {
		if err := gdb.Create(&models.CashShift{
			ID: uuid.NewString(), Status: &closed, OpenedAt: when, RestaurantID: &f.rid,
		}).Error; err != nil {
			t.Fatal(err)
		}
	}

	count := func() int {
		resp, b := f.get(t, "/api/v1/shifts?limit=50", tok)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("shifts list: %d %s", resp.StatusCode, b)
		}
		var env struct {
			Data []json.RawMessage `json:"data"`
		}
		if err := json.Unmarshal(b, &env); err != nil {
			t.Fatal(err)
		}
		return len(env.Data)
	}

	// Без shifts.history — только сегодняшняя.
	if err := gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"shifts.manage":true}}`))).Error; err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 1 {
		t.Fatalf("без shifts.history ожидали 1 (сегодня), получили %d", n)
	}

	// С shifts.history — обе.
	if err := gdb.Model(&models.User{}).Where("restaurant_id = ?", f.rid).
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"shifts.manage":true,"shifts.history":true}}`))).Error; err != nil {
		t.Fatal(err)
	}
	if n := count(); n != 2 {
		t.Fatalf("с shifts.history ожидали 2 (все дни), получили %d", n)
	}
}
