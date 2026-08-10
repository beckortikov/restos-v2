//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"
)

// Настройки ТВ-табло (миграция 072) round-trip'ятся: PATCH board_stations +
// board_logo_opacity сохраняются и возвращаются в GET restaurant; яркость
// клампится в 0..100.
func TestRestaurantBoardSettings_RoundTrip(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	get := func(t *testing.T) (stations string, opacity int) {
		t.Helper()
		r, b := f.get(t, "/api/v1/restaurants/"+f.rid, tok)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("get restaurant: %d %s", r.StatusCode, b)
		}
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		if s, ok := m["board_stations"].(string); ok {
			stations = s
		}
		if o, ok := m["board_logo_opacity"].(float64); ok {
			opacity = int(o)
		}
		return
	}

	// Сохраняем станции + яркость.
	r, b := f.patch(t, "/api/v1/restaurants/"+f.rid, tok, uuid.NewString(), map[string]any{
		"board_stations":     "pizza,grill",
		"board_logo_opacity": 22,
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("patch board settings: %d %s", r.StatusCode, b)
	}
	if st, op := get(t); st != "pizza,grill" || op != 22 {
		t.Fatalf("после сохранения ожидали stations=pizza,grill opacity=22, получили stations=%q opacity=%d", st, op)
	}

	// Яркость выше 100 — клампится до 100.
	r, b = f.patch(t, "/api/v1/restaurants/"+f.rid, tok, uuid.NewString(), map[string]any{
		"board_logo_opacity": 150,
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("patch opacity clamp: %d %s", r.StatusCode, b)
	}
	if _, op := get(t); op != 100 {
		t.Fatalf("яркость 150 должна клампиться до 100, получили %d", op)
	}

	// Пустые станции = все (сбрасываем фильтр).
	r, b = f.patch(t, "/api/v1/restaurants/"+f.rid, tok, uuid.NewString(), map[string]any{
		"board_stations": "",
	})
	if r.StatusCode != http.StatusOK {
		t.Fatalf("patch clear stations: %d %s", r.StatusCode, b)
	}
	if st, _ := get(t); st != "" {
		t.Fatalf("после сброса ожидали пустые станции, получили %q", st)
	}
}
