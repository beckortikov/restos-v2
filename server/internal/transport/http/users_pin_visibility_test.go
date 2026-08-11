//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// PIN виден в GET /users только привилегированным ролям. Кассир/официант PIN не
// получают — иначе увидели бы чужой PIN и вошли под чужой ролью (PIN-разделение
// ролей потеряло бы смысл). Owner/manager видят — чтобы «сотрудник забыл PIN»
// решалось просмотром, а не перегенерацией нового.
func TestUsersList_PINVisibility_ByRole(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	// Ещё один сотрудник со своим PIN — именно его «подсматривает» руководитель.
	wName, wPIN, wRole := "Официант", "5678", "waiter"
	if err := gdb.Create(&models.User{
		ID: uuid.NewString(), Name: &wName, PIN: &wPIN, Role: &wRole, RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}

	// pinsByName — карта имя→pin из ответа GET /users (пустая строка = PIN не отдан).
	pinsByName := func(t *testing.T) map[string]string {
		t.Helper()
		r, b := f.get(t, "/api/v1/users", tok)
		if r.StatusCode != http.StatusOK {
			t.Fatalf("list users: %d %s", r.StatusCode, b)
		}
		var env struct {
			Data []map[string]any `json:"data"`
		}
		if err := json.Unmarshal(b, &env); err != nil {
			t.Fatalf("unmarshal: %v", err)
		}
		out := map[string]string{}
		for _, row := range env.Data {
			name, _ := row["name"].(string)
			pin, _ := row["pin"].(string)
			out[name] = pin
		}
		return out
	}

	// Кассир (дефолтная фикстура) — PIN не видит НИ у кого, даже у себя.
	asCashier := pinsByName(t)
	if asCashier[wName] != "" {
		t.Errorf("кассир видит чужой PIN (%q) — не должен", asCashier[wName])
	}
	if asCashier["Cashier"] != "" {
		t.Errorf("кассир видит PIN в /users (%q) — PIN не должен течь непривилегированным", asCashier["Cashier"])
	}

	// Повышаем login-юзера до owner. CanSeePINs перечитывает роль из БД (не из
	// токена), поэтому тот же токен теперь получает PIN'ы.
	if err := gdb.Model(&models.User{}).Where("restaurant_id = ? AND pin = ?", f.rid, f.pin).
		Update("role", "owner").Error; err != nil {
		t.Fatal(err)
	}

	asOwner := pinsByName(t)
	if asOwner[wName] != wPIN {
		t.Errorf("owner должен видеть PIN официанта %q, получил %q", wPIN, asOwner[wName])
	}
}
