//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Блюдо, помеченное «СТОП» вручную в меню (is_available=false), должно попадать
// в стоп-лист (с флагом unavailable). Раньше стоп-лист включал только
// stop_list_override / авто-стоп по остаткам, и такое блюдо не показывалось.
func TestStopList_IncludesUnavailable(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	avail := false
	miID, n := uuid.NewString(), "Стоп-блюдо вручную"
	if err := gdb.Create(&models.MenuItem{
		ID: miID, Name: &n, Price: decimal.MustFromString("100"),
		RestaurantID: &f.rid, IsAvailable: &avail,
	}).Error; err != nil {
		t.Fatal(err)
	}

	resp, b := f.get(t, "/api/v1/stop-list", tok)
	if resp.StatusCode != http.StatusOK {
		t.Fatalf("stop-list: %d %s", resp.StatusCode, b)
	}
	var env struct {
		Data []struct {
			MenuItemID  string `json:"menu_item_id"`
			Unavailable bool   `json:"unavailable"`
		} `json:"data"`
	}
	if err := json.Unmarshal(b, &env); err != nil {
		t.Fatal(err)
	}
	// Допускаем как {data:[...]}, так и голый массив.
	rows := env.Data
	if len(rows) == 0 {
		var bare []struct {
			MenuItemID  string `json:"menu_item_id"`
			Unavailable bool   `json:"unavailable"`
		}
		_ = json.Unmarshal(b, &bare)
		rows = bare
	}
	found := false
	for _, r := range rows {
		if r.MenuItemID == miID {
			found = true
			if !r.Unavailable {
				t.Fatalf("ожидали unavailable=true для ручного СТОП-блюда")
			}
		}
	}
	if !found {
		t.Fatalf("блюдо с is_available=false НЕ попало в стоп-лист: %s", b)
	}
}
