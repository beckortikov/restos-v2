//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Список меню должен отдаваться полностью через курсор: бэк зажимает limit до
// 200, поэтому клиент обязан идти по next_cursor. Тест проверяет контракт:
// при странице меньше общего числа возвращается next_cursor, и проход по нему
// собирает все позиции (раньше фронт брал только первую страницу → блюда >200
// пропадали из меню и Склад→Меню).
func TestMenuList_CursorReturnsAll(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb := openTestDB(t)

	const total = 5
	want := map[string]bool{}
	for i := 0; i < total; i++ {
		id, name := uuid.NewString(), fmt.Sprintf("Паг-блюдо-%02d", i)
		if err := gdb.Create(&models.MenuItem{
			ID: id, Name: &name, Price: decimal.MustFromString("10"), RestaurantID: &f.rid,
		}).Error; err != nil {
			t.Fatal(err)
		}
		want[id] = true
	}

	got := map[string]bool{}
	cursor := ""
	for page := 0; page < 50; page++ {
		path := "/api/v1/menu/items?limit=2"
		if cursor != "" {
			path += "&cursor=" + cursor
		}
		resp, b := f.get(t, path, tok)
		if resp.StatusCode != http.StatusOK {
			t.Fatalf("list page %d: %d %s", page, resp.StatusCode, b)
		}
		var env struct {
			Data []struct {
				ID string `json:"id"`
			} `json:"data"`
			NextCursor string `json:"next_cursor"`
		}
		if err := json.Unmarshal(b, &env); err != nil {
			t.Fatal(err)
		}
		for _, it := range env.Data {
			got[it.ID] = true
		}
		if env.NextCursor == "" || len(env.Data) == 0 {
			break
		}
		cursor = env.NextCursor
	}

	missing := 0
	for id := range want {
		if !got[id] {
			missing++
		}
	}
	if missing > 0 {
		t.Fatalf("через курсор не вернулись %d из %d созданных блюд (собрано %d)", missing, total, len(got))
	}
}
