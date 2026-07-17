//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
)

type sizeScaleValueDTO struct {
	ID        string `json:"id"`
	Code      string `json:"code"`
	Title     string `json:"title"`
	SortOrder int    `json:"sort_order"`
	IsDefault bool   `json:"is_default"`
}

type sizeScaleDTO struct {
	ID     string              `json:"id"`
	Name   string              `json:"name"`
	Values []sizeScaleValueDTO `json:"values"`
}

// TestSizeScales_CreateListPatchDelete — базовый CRUD-цикл шкалы размеров:
// создание со значениями → появляется в списке → patch полностью заменяет
// значения (delete+recreate) → delete убирает шкалу.
func TestSizeScales_CreateListPatchDelete(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	create := map[string]any{
		"name": "Пиццы 25/30/35",
		"values": []map[string]any{
			{"code": "25", "sort_order": 0},
			{"code": "30", "sort_order": 1, "is_default": true},
			{"code": "35", "sort_order": 2},
		},
	}
	r, b := f.post(t, "/api/v1/size-scales", tok, uuid.NewString(), create)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create scale: %d %s", r.StatusCode, b)
	}
	var scale sizeScaleDTO
	if err := json.Unmarshal(b, &scale); err != nil {
		t.Fatal(err)
	}
	if scale.ID == "" || len(scale.Values) != 3 {
		t.Fatalf("ожидали шкалу с 3 значениями, получили %+v", scale)
	}

	rl, bl := f.get(t, "/api/v1/size-scales", tok)
	if rl.StatusCode != http.StatusOK {
		t.Fatalf("list scales: %d %s", rl.StatusCode, bl)
	}
	var list struct {
		Data []sizeScaleDTO `json:"data"`
	}
	_ = json.Unmarshal(bl, &list)
	found := false
	for _, s := range list.Data {
		if s.ID == scale.ID {
			found = true
		}
	}
	if !found {
		t.Fatalf("созданная шкала не найдена в списке: %+v", list.Data)
	}

	// Patch — полная замена значений на 2 других.
	patch := map[string]any{
		"values": []map[string]any{
			{"code": "40", "sort_order": 0},
			{"code": "45", "sort_order": 1},
		},
	}
	rp, bp := f.patch(t, "/api/v1/size-scales/"+scale.ID, tok, uuid.NewString(), patch)
	if rp.StatusCode != http.StatusOK {
		t.Fatalf("patch scale: %d %s", rp.StatusCode, bp)
	}
	var patched sizeScaleDTO
	_ = json.Unmarshal(bp, &patched)
	if len(patched.Values) != 2 {
		t.Fatalf("ожидали 2 значения после patch (полная замена), получили %+v", patched.Values)
	}
	for _, v := range patched.Values {
		if v.Code != "40" && v.Code != "45" {
			t.Errorf("неожиданное значение после замены: %+v", v)
		}
	}

	rd, bd := f.del(t, "/api/v1/size-scales/"+scale.ID, tok, uuid.NewString())
	if rd.StatusCode != http.StatusNoContent {
		t.Fatalf("delete scale: %d %s", rd.StatusCode, bd)
	}
	rd2, bd2 := f.patch(t, "/api/v1/size-scales/"+scale.ID, tok, uuid.NewString(), map[string]any{"name": "x"})
	if rd2.StatusCode != http.StatusNotFound {
		t.Fatalf("ожидали 404 после удаления шкалы, получили %d %s", rd2.StatusCode, bd2)
	}
}

// TestSizeScales_DeleteUnlinksDependents — удаление шкалы не должно валить
// связанные menu_attributes/semi_finished_types: FK ON DELETE SET NULL должен
// откатить их к NULL, а не запретить удаление и не утащить их за собой.
func TestSizeScales_DeleteUnlinksDependents(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	rs, bs := f.post(t, "/api/v1/size-scales", tok, uuid.NewString(), map[string]any{
		"name":   "Пиццы 25/30",
		"values": []map[string]any{{"code": "25"}, {"code": "30"}},
	})
	if rs.StatusCode != http.StatusCreated {
		t.Fatalf("create scale: %d %s", rs.StatusCode, bs)
	}
	var scale sizeScaleDTO
	_ = json.Unmarshal(bs, &scale)

	product := createAttrProduct(t, f, tok, "Пепперони", nil)
	pid := product["id"].(string)
	rput, bput := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), map[string]any{
		"attributes": []map[string]any{{"name": "Размер", "size_scale_id": scale.ID, "values": []map[string]any{}}},
		"combos": []map[string]any{
			{"labels": []string{"25"}, "price": "50"},
			{"labels": []string{"30"}, "price": "65"},
		},
	})
	if rput.StatusCode != http.StatusOK {
		t.Fatalf("PUT attributes (scale-linked): %d %s", rput.StatusCode, bput)
	}

	rdel, bdel := f.del(t, "/api/v1/size-scales/"+scale.ID, tok, uuid.NewString())
	if rdel.StatusCode != http.StatusNoContent {
		t.Fatalf("delete scale: %d %s", rdel.StatusCode, bdel)
	}

	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	var attr models.MenuAttribute
	if err := gdb.Where("menu_item_id = ?", pid).First(&attr).Error; err != nil {
		t.Fatalf("атрибут продукта должен остаться после удаления шкалы: %v", err)
	}
	if attr.SizeScaleID != nil {
		t.Errorf("ожидали size_scale_id=NULL после удаления шкалы, получили %v", *attr.SizeScaleID)
	}
	var cnt int64
	gdb.Model(&models.MenuItem{}).Where("parent_id = ? AND is_deleted = ?", pid, false).Count(&cnt)
	if cnt != 2 {
		t.Errorf("варианты продукта не должны исчезнуть при удалении шкалы, ожидали 2 живых, получили %d", cnt)
	}
}

// TestSizeScales_TenantIsolation — CRUD шкалы чужого ресторана должен 404.
func TestSizeScales_TenantIsolation(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	ridB := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: ridB, Name: "Other"}).Error; err != nil {
		t.Fatal(err)
	}
	otherScale := &models.SizeScale{ID: uuid.NewString(), Name: "Other scale", RestaurantID: &ridB}
	if err := gdb.Create(otherScale).Error; err != nil {
		t.Fatal(err)
	}

	rp, bp := f.patch(t, "/api/v1/size-scales/"+otherScale.ID, tok, uuid.NewString(), map[string]any{"name": "hacked"})
	if rp.StatusCode != http.StatusNotFound {
		t.Fatalf("ожидали 404 для чужого ресторана, получили %d %s", rp.StatusCode, bp)
	}
	rd, bd := f.del(t, "/api/v1/size-scales/"+otherScale.ID, tok, uuid.NewString())
	if rd.StatusCode != http.StatusNotFound {
		t.Fatalf("ожидали 404 при delete на чужой ресторан, получили %d %s", rd.StatusCode, bd)
	}
}
