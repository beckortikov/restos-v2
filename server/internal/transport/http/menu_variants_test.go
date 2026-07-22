//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"io"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// put — PUT-helper аналогичный post/patch (внутри пакета аналогов пока нет).
func (f *e2eFixture) put(t *testing.T, path, token, idemKey string, body any) (*http.Response, []byte) {
	t.Helper()
	b, _ := json.Marshal(body)
	req, _ := http.NewRequest("PUT", f.srv.URL+path, bytes.NewReader(b))
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if idemKey != "" {
		req.Header.Set("Idempotency-Key", idemKey)
	}
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	rb, _ := io.ReadAll(resp.Body)
	return resp, rb
}

// createAttrProduct — вспомогательный продукт для PUT /attributes-сценариев.
func createAttrProduct(t *testing.T, f *e2eFixture, tok, name string, extra map[string]any) map[string]any {
	t.Helper()
	body := map[string]any{"name": name, "category": "Напитки", "price": "15"}
	for k, v := range extra {
		body[k] = v
	}
	r, b := f.post(t, "/api/v1/menu/items", tok, uuid.NewString(), body)
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create menu item: %d %s", r.StatusCode, b)
	}
	var created map[string]any
	if err := json.Unmarshal(b, &created); err != nil {
		t.Fatal(err)
	}
	return created
}

type attrValueDTO struct {
	ID    string `json:"id"`
	Label string `json:"label"`
}

type attrDTO struct {
	ID     string         `json:"id"`
	Name   string         `json:"name"`
	Values []attrValueDTO `json:"values"`
}

type variantDTO struct {
	ID        string   `json:"id"`
	Name      string   `json:"name"`
	Price     string   `json:"price"`
	COGS      string   `json:"cogs"`
	IsDeleted bool     `json:"is_deleted"`
	ValueIDs  []string `json:"value_ids"`
}

type attributesState struct {
	Attributes []attrDTO    `json:"attributes"`
	Variants   []variantDTO `json:"variants"`
}

// TestMenuAttributes_CreateVariantsWithPricing — core flow: один атрибут
// («Объём» × 2 значения) с ценами комбинаций → 2 варианта, каждый со своей
// ценой; GET после PUT возвращает то же состояние.
func TestMenuAttributes_CreateVariantsWithPricing(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	product := createAttrProduct(t, f, tok, "Fanta", nil)
	pid := product["id"].(string)

	payload := map[string]any{
		"attributes": []map[string]any{
			{"name": "Объём", "values": []map[string]any{{"label": "1 л"}, {"label": "1.5 л"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"1 л"}, "price": "20"},
			{"labels": []string{"1.5 л"}, "price": "28"},
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), payload)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("PUT attributes: %d %s", r.StatusCode, b)
	}
	var state attributesState
	if err := json.Unmarshal(b, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Attributes) != 1 || len(state.Attributes[0].Values) != 2 {
		t.Fatalf("ожидали 1 атрибут с 2 значениями, получили %+v", state.Attributes)
	}
	if len(state.Variants) != 2 {
		t.Fatalf("ожидали 2 варианта, получили %d: %+v", len(state.Variants), state.Variants)
	}
	byName := map[string]variantDTO{}
	for _, v := range state.Variants {
		byName[v.Name] = v
	}
	v1, ok1 := byName["Fanta 1 л"]
	v2, ok2 := byName["Fanta 1.5 л"]
	if !ok1 || !ok2 {
		t.Fatalf("ожидали варианты «Fanta 1 л»/«Fanta 1.5 л», получили %+v", byName)
	}
	if !decimal.MustFromString(v1.Price).Equal(decimal.MustFromString("20")) {
		t.Errorf("Fanta 1 л price: ожидали 20, получили %s", v1.Price)
	}
	if !decimal.MustFromString(v2.Price).Equal(decimal.MustFromString("28")) {
		t.Errorf("Fanta 1.5 л price: ожидали 28, получили %s", v2.Price)
	}
	if len(v1.ValueIDs) != 1 || len(v2.ValueIDs) != 1 {
		t.Errorf("ожидали по 1 value_id на вариант, получили v1=%v v2=%v", v1.ValueIDs, v2.ValueIDs)
	}

	// GET должен вернуть идентичное состояние.
	rg, bg := f.get(t, "/api/v1/menu/items/"+pid+"/attributes", tok)
	if rg.StatusCode != http.StatusOK {
		t.Fatalf("GET attributes: %d %s", rg.StatusCode, bg)
	}
	var got attributesState
	_ = json.Unmarshal(bg, &got)
	if len(got.Variants) != 2 {
		t.Fatalf("GET после PUT: ожидали 2 варианта, получили %d", len(got.Variants))
	}
}

// TestMenuAttributes_TwoAttributesCartesianProduct — 2 атрибута × 2 значения
// = 4 варианта (декартово произведение), с независимыми ценами по комбинации.
func TestMenuAttributes_TwoAttributesCartesianProduct(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	product := createAttrProduct(t, f, tok, "Сок", nil)
	pid := product["id"].(string)

	payload := map[string]any{
		"attributes": []map[string]any{
			{"name": "Объём", "values": []map[string]any{{"label": "0.3 л"}, {"label": "0.5 л"}}},
			{"name": "Вкус", "values": []map[string]any{{"label": "Апельсин"}, {"label": "Яблоко"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"0.3 л", "Апельсин"}, "price": "12"},
			{"labels": []string{"0.3 л", "Яблоко"}, "price": "13"},
			{"labels": []string{"0.5 л", "Апельсин"}, "price": "18"},
			{"labels": []string{"0.5 л", "Яблоко"}, "price": "19"},
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), payload)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("PUT attributes: %d %s", r.StatusCode, b)
	}
	var state attributesState
	_ = json.Unmarshal(b, &state)
	if len(state.Variants) != 4 {
		t.Fatalf("ожидали 4 варианта (2×2), получили %d: %+v", len(state.Variants), state.Variants)
	}
	byName := map[string]string{}
	for _, v := range state.Variants {
		byName[v.Name] = v.Price
	}
	want := map[string]string{
		"Сок 0.3 л Апельсин": "12",
		"Сок 0.3 л Яблоко":   "13",
		"Сок 0.5 л Апельсин": "18",
		"Сок 0.5 л Яблоко":   "19",
	}
	for name, price := range want {
		got, ok := byName[name]
		if !ok {
			t.Fatalf("не найден вариант %q среди %+v", name, byName)
		}
		if !decimal.MustFromString(got).Equal(decimal.MustFromString(price)) {
			t.Errorf("%s: ожидали цену %s, получили %s", name, price, got)
		}
	}
}

// TestMenuAttributes_MissingComboPriceRejected — если цена задана не для
// каждой комбинации декартова произведения, весь PUT отклоняется (400) и
// ничего не создаётся.
func TestMenuAttributes_MissingComboPriceRejected(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	product := createAttrProduct(t, f, tok, "Спрайт", nil)
	pid := product["id"].(string)

	payload := map[string]any{
		"attributes": []map[string]any{
			{"name": "Объём", "values": []map[string]any{{"label": "1 л"}, {"label": "1.5 л"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"1 л"}, "price": "20"},
			// цена для «1.5 л» не задана.
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), payload)
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("ожидали 400, получили %d %s", r.StatusCode, b)
	}
	var env struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(b, &env)
	if env.Code != "VALIDATION" {
		t.Errorf("ожидали code=VALIDATION, получили %q (%s)", env.Code, b)
	}

	// Ничего не должно было создаться (транзакция откатилась).
	rg, bg := f.get(t, "/api/v1/menu/items/"+pid+"/attributes", tok)
	if rg.StatusCode != http.StatusOK {
		t.Fatalf("GET attributes: %d %s", rg.StatusCode, bg)
	}
	var got attributesState
	_ = json.Unmarshal(bg, &got)
	if len(got.Attributes) != 0 || len(got.Variants) != 0 {
		t.Fatalf("ожидали пустое состояние после отклонённого PUT, получили %+v", got)
	}
}

// TestMenuAttributes_TooManyAttributesRejected — максимум 3 атрибута на товар.
func TestMenuAttributes_TooManyAttributesRejected(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	product := createAttrProduct(t, f, tok, "Комбо", nil)
	pid := product["id"].(string)

	attrs := []map[string]any{}
	for i := 0; i < 4; i++ {
		attrs = append(attrs, map[string]any{
			"name":   uuid.NewString(),
			"values": []map[string]any{{"label": "A"}, {"label": "B"}},
		})
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), map[string]any{"attributes": attrs})
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("ожидали 400 (>3 атрибутов), получили %d %s", r.StatusCode, b)
	}
}

// TestMenuAttributes_RemoveValueArchivesThenResurrects — удаление значения
// из sync архивирует соответствующий вариант (soft-delete, не hard-delete);
// повторное добавление того же лейбла воскрешает ТОТ ЖЕ вариант (сохраняя
// его id/SKU), а не создаёт новый.
func TestMenuAttributes_RemoveValueArchivesThenResurrects(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	product := createAttrProduct(t, f, tok, "Кола", nil)
	pid := product["id"].(string)

	create := map[string]any{
		"attributes": []map[string]any{
			{"name": "Объём", "values": []map[string]any{{"label": "1 л"}, {"label": "1.5 л"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"1 л"}, "price": "20"},
			{"labels": []string{"1.5 л"}, "price": "28"},
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), create)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("initial PUT: %d %s", r.StatusCode, b)
	}
	var state1 attributesState
	_ = json.Unmarshal(b, &state1)
	var attrID string
	for _, a := range state1.Attributes {
		attrID = a.ID
	}
	var oldVariant1L string
	for _, v := range state1.Variants {
		if v.Name == "Кола 1 л" {
			oldVariant1L = v.ID
		}
	}
	if attrID == "" || oldVariant1L == "" {
		t.Fatalf("не удалось найти исходные id: %+v", state1)
	}

	// Убираем значение «1 л» из sync — остаётся только «1.5 л».
	shrink := map[string]any{
		"attributes": []map[string]any{
			{"id": attrID, "name": "Объём", "values": []map[string]any{{"label": "1.5 л"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"1.5 л"}, "price": "28"},
		},
	}
	r2, b2 := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), shrink)
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("shrink PUT: %d %s", r2.StatusCode, b2)
	}
	var state2 attributesState
	_ = json.Unmarshal(b2, &state2)
	if len(state2.Variants) != 1 || state2.Variants[0].Name != "Кола 1.5 л" {
		t.Fatalf("ожидали 1 живой вариант «Кола 1.5 л», получили %+v", state2.Variants)
	}

	// Вариант «1 л» должен быть архивирован (soft-delete), не удалён физически.
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	var archived models.MenuItem
	if err := gdb.Where("id = ?", oldVariant1L).First(&archived).Error; err != nil {
		t.Fatalf("архивный вариант должен остаться в БД: %v", err)
	}
	if !archived.IsDeleted {
		t.Fatalf("вариант «1 л» должен быть is_deleted=true после удаления значения")
	}

	// Возвращаем значение «1 л» обратно — должен воскреснуть ТОТ ЖЕ вариант.
	restore := map[string]any{
		"attributes": []map[string]any{
			{"id": attrID, "name": "Объём", "values": []map[string]any{{"label": "1.5 л"}, {"label": "1 л"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"1.5 л"}, "price": "28"},
			{"labels": []string{"1 л"}, "price": "22"},
		},
	}
	r3, b3 := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), restore)
	if r3.StatusCode != http.StatusOK {
		t.Fatalf("restore PUT: %d %s", r3.StatusCode, b3)
	}
	var state3 attributesState
	_ = json.Unmarshal(b3, &state3)
	if len(state3.Variants) != 2 {
		t.Fatalf("ожидали 2 живых варианта после воскрешения, получили %d", len(state3.Variants))
	}
	var resurrected variantDTO
	found := false
	for _, v := range state3.Variants {
		if v.Name == "Кола 1 л" {
			resurrected = v
			found = true
		}
	}
	if !found {
		t.Fatalf("вариант «Кола 1 л» не воскрес: %+v", state3.Variants)
	}
	if resurrected.ID != oldVariant1L {
		t.Fatalf("ожидали воскрешение ТОГО ЖЕ варианта id=%s, получили новый id=%s", oldVariant1L, resurrected.ID)
	}
	if !decimal.MustFromString(resurrected.Price).Equal(decimal.MustFromString("22")) {
		t.Errorf("воскрешённый вариант: ожидали новую цену 22, получили %s", resurrected.Price)
	}
}

// TestMenuAttributes_EmptyAttributesArchivesAllVariants — PUT с пустым
// attributes[] снимает все атрибуты и архивирует все варианты (товар снова
// становится обычным блюдом).
func TestMenuAttributes_EmptyAttributesArchivesAllVariants(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	product := createAttrProduct(t, f, tok, "Пепси", nil)
	pid := product["id"].(string)

	create := map[string]any{
		"attributes": []map[string]any{
			{"name": "Объём", "values": []map[string]any{{"label": "1 л"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"1 л"}, "price": "20"},
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), create)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("initial PUT: %d %s", r.StatusCode, b)
	}
	var state attributesState
	_ = json.Unmarshal(b, &state)
	if len(state.Variants) != 1 {
		t.Fatalf("ожидали 1 вариант, получили %+v", state.Variants)
	}
	variantID := state.Variants[0].ID

	r2, b2 := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), map[string]any{"attributes": []map[string]any{}})
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("clear PUT: %d %s", r2.StatusCode, b2)
	}
	var cleared attributesState
	_ = json.Unmarshal(b2, &cleared)
	if len(cleared.Attributes) != 0 || len(cleared.Variants) != 0 {
		t.Fatalf("ожидали пустое состояние после очистки, получили %+v", cleared)
	}

	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	var archived models.MenuItem
	if err := gdb.Where("id = ?", variantID).First(&archived).Error; err != nil {
		t.Fatalf("вариант должен остаться в БД архивным: %v", err)
	}
	if !archived.IsDeleted {
		t.Fatalf("ожидали is_deleted=true у варианта после очистки атрибутов")
	}
	var attrCount int64
	gdb.Model(&models.MenuAttribute{}).Where("menu_item_id = ?", pid).Count(&attrCount)
	if attrCount != 0 {
		t.Fatalf("ожидали 0 атрибутов после очистки, получили %d", attrCount)
	}
}

// TestMenuAttributes_VariantCannotHaveOwnAttributes — PUT /attributes на уже
// сгенерированный вариант (у него ParentID != nil) должен быть отклонён.
func TestMenuAttributes_VariantCannotHaveOwnAttributes(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	product := createAttrProduct(t, f, tok, "Мирафрут", nil)
	pid := product["id"].(string)

	create := map[string]any{
		"attributes": []map[string]any{
			{"name": "Объём", "values": []map[string]any{{"label": "1 л"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"1 л"}, "price": "20"},
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), create)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("initial PUT: %d %s", r.StatusCode, b)
	}
	var state attributesState
	_ = json.Unmarshal(b, &state)
	variantID := state.Variants[0].ID

	r2, b2 := f.put(t, "/api/v1/menu/items/"+variantID+"/attributes", tok, uuid.NewString(), map[string]any{
		"attributes": []map[string]any{{"name": "Вкус", "values": []map[string]any{{"label": "X"}}}},
		"combos":     []map[string]any{{"labels": []string{"X"}, "price": "5"}},
	})
	if r2.StatusCode != http.StatusBadRequest {
		t.Fatalf("ожидали 400 (вариант не может иметь свои атрибуты), получили %d %s", r2.StatusCode, b2)
	}
}

// TestMenuAttributes_PurchasedProductSyncsIngredientPrice — для покупного
// товара purchase_price комбинации должен попадать в cogs варианта и в
// price_per_unit его backing-ингредиента (склад).
func TestMenuAttributes_PurchasedProductSyncsIngredientPrice(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	product := createAttrProduct(t, f, tok, "Вода", map[string]any{
		"is_purchased": true, "purchase_price": "5", "purchase_unit": "шт",
	})
	pid := product["id"].(string)

	create := map[string]any{
		"attributes": []map[string]any{
			{"name": "Объём", "values": []map[string]any{{"label": "0.5 л"}, {"label": "1.5 л"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"0.5 л"}, "price": "10", "purchase_price": "6"},
			{"labels": []string{"1.5 л"}, "price": "16", "purchase_price": "9"},
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), create)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("PUT attributes: %d %s", r.StatusCode, b)
	}
	var state attributesState
	_ = json.Unmarshal(b, &state)
	var v05 variantDTO
	for _, v := range state.Variants {
		if v.Name == "Вода 0.5 л" {
			v05 = v
		}
	}
	if v05.ID == "" {
		t.Fatalf("не найден вариант «Вода 0.5 л»: %+v", state.Variants)
	}
	if !decimal.MustFromString(v05.COGS).Equal(decimal.MustFromString("6")) {
		t.Errorf("ожидали cogs=6 у варианта 0.5 л, получили %s", v05.COGS)
	}

	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	var line models.TechCardLine
	if err := gdb.Where("menu_item_id = ?", v05.ID).First(&line).Error; err != nil {
		t.Fatalf("ожидали 1:1 техкарту у варианта: %v", err)
	}
	if line.IngredientID == nil {
		t.Fatalf("techcard line без ingredient_id")
	}
	var ing models.Ingredient
	if err := gdb.Where("id = ?", *line.IngredientID).First(&ing).Error; err != nil {
		t.Fatal(err)
	}
	if !ing.PricePerUnit.Equal(decimal.MustFromString("6")) {
		t.Errorf("backing-ингредиент price_per_unit: ожидали 6, получили %s", decimal.Normalize(ing.PricePerUnit))
	}
}

// TestMenuAttributes_TenantIsolation — GET/PUT атрибутов чужого ресторана
// должны возвращать 404, а не утечку данных другого tenant'а.
func TestMenuAttributes_TenantIsolation(t *testing.T) {
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
	otherName := "Other Product"
	otherItem := &models.MenuItem{Name: &otherName, Price: decimal.MustFromString("10"), RestaurantID: &ridB}
	if err := gdb.Create(otherItem).Error; err != nil {
		t.Fatal(err)
	}

	r, b := f.get(t, "/api/v1/menu/items/"+otherItem.ID+"/attributes", tok)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("ожидали 404 для чужого ресторана, получили %d %s", r.StatusCode, b)
	}

	r2, b2 := f.put(t, "/api/v1/menu/items/"+otherItem.ID+"/attributes", tok, uuid.NewString(), map[string]any{
		"attributes": []map[string]any{{"name": "X", "values": []map[string]any{{"label": "Y"}}}},
		"combos":     []map[string]any{{"labels": []string{"Y"}, "price": "1"}},
	})
	if r2.StatusCode != http.StatusNotFound {
		t.Fatalf("ожидали 404 при PUT на чужой ресторан, получили %d %s", r2.StatusCode, b2)
	}
}

// createSizeScale — вспомогательная шкала размеров для scale-linked сценариев.
func createSizeScale(t *testing.T, f *e2eFixture, tok, name string, codes ...string) sizeScaleDTO {
	t.Helper()
	values := make([]map[string]any, 0, len(codes))
	for i, c := range codes {
		values = append(values, map[string]any{"code": c, "sort_order": i})
	}
	r, b := f.post(t, "/api/v1/size-scales", tok, uuid.NewString(), map[string]any{"name": name, "values": values})
	if r.StatusCode != http.StatusCreated {
		t.Fatalf("create size scale: %d %s", r.StatusCode, b)
	}
	var scale sizeScaleDTO
	if err := json.Unmarshal(b, &scale); err != nil {
		t.Fatal(err)
	}
	return scale
}

// TestMenuAttributes_ScaleLinkedAttributeDerivesValues — атрибут с
// size_scale_id (и пустым values) должен породить значения/варианты из
// значений шкалы, не из тела запроса — ключевой сценарий шкал размеров пиццы.
func TestMenuAttributes_ScaleLinkedAttributeDerivesValues(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	scale := createSizeScale(t, f, tok, "Пиццы 25/30/35", "25", "30", "35")
	product := createAttrProduct(t, f, tok, "Пепперони", nil)
	pid := product["id"].(string)

	payload := map[string]any{
		"attributes": []map[string]any{
			{"name": "Размер", "size_scale_id": scale.ID, "values": []map[string]any{}},
		},
		"combos": []map[string]any{
			{"labels": []string{"25"}, "price": "50"},
			{"labels": []string{"30"}, "price": "65"},
			{"labels": []string{"35"}, "price": "80"},
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), payload)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("PUT attributes (scale-linked): %d %s", r.StatusCode, b)
	}
	var state attributesState
	if err := json.Unmarshal(b, &state); err != nil {
		t.Fatal(err)
	}
	if len(state.Attributes) != 1 || len(state.Attributes[0].Values) != 3 {
		t.Fatalf("ожидали 1 атрибут с 3 значениями из шкалы, получили %+v", state.Attributes)
	}
	if len(state.Variants) != 3 {
		t.Fatalf("ожидали 3 варианта (по значению шкалы), получили %d: %+v", len(state.Variants), state.Variants)
	}
	byName := map[string]string{}
	for _, v := range state.Variants {
		byName[v.Name] = v.Price
	}
	want := map[string]string{"Пепперони 25": "50", "Пепперони 30": "65", "Пепперони 35": "80"}
	for name, price := range want {
		got, ok := byName[name]
		if !ok {
			t.Fatalf("не найден вариант %q среди %+v", name, byName)
		}
		if !decimal.MustFromString(got).Equal(decimal.MustFromString(price)) {
			t.Errorf("%s: ожидали цену %s, получили %s", name, price, got)
		}
	}
}

// TestMenuAttributes_ScaleLinkedAttributeSyncsOnScaleValueRename — переименование
// значения шкалы (25 → «Маленькая 25 см») подхватывается при следующем PUT
// /attributes того же продукта (мирroring, не статичная копия на момент линковки).
func TestMenuAttributes_ScaleLinkedAttributeSyncsOnScaleValueRename(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	scale := createSizeScale(t, f, tok, "Пиццы 25/30", "25", "30")
	product := createAttrProduct(t, f, tok, "Маргарита", nil)
	pid := product["id"].(string)

	create := map[string]any{
		"attributes": []map[string]any{{"name": "Размер", "size_scale_id": scale.ID, "values": []map[string]any{}}},
		"combos": []map[string]any{
			{"labels": []string{"25"}, "price": "40"},
			{"labels": []string{"30"}, "price": "55"},
		},
	}
	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), create)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("initial PUT: %d %s", r.StatusCode, b)
	}

	// Переименовываем значение «25» шкалы в «Маленькая 25 см».
	rp, bp := f.patch(t, "/api/v1/size-scales/"+scale.ID, tok, uuid.NewString(), map[string]any{
		"values": []map[string]any{
			{"code": "25", "title": "Маленькая 25 см", "sort_order": 0},
			{"code": "30", "sort_order": 1},
		},
	})
	if rp.StatusCode != http.StatusOK {
		t.Fatalf("patch scale: %d %s", rp.StatusCode, bp)
	}

	// Ре-синк того же атрибута (без изменений combos) должен подхватить новый лейбл.
	resync := map[string]any{
		"attributes": []map[string]any{{"name": "Размер", "size_scale_id": scale.ID, "values": []map[string]any{}}},
		"combos": []map[string]any{
			{"labels": []string{"Маленькая 25 см"}, "price": "40"},
			{"labels": []string{"30"}, "price": "55"},
		},
	}
	r2, b2 := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), resync)
	if r2.StatusCode != http.StatusOK {
		t.Fatalf("resync PUT: %d %s", r2.StatusCode, b2)
	}
	var state attributesState
	_ = json.Unmarshal(b2, &state)
	byName := map[string]bool{}
	for _, v := range state.Variants {
		byName[v.Name] = true
	}
	if !byName["Маргарита Маленькая 25 см"] {
		t.Fatalf("ожидали вариант с обновлённым лейблом «Маргарита Маленькая 25 см», получили %+v", state.Variants)
	}
	if byName["Маргарита 25"] {
		t.Fatalf("старый лейбл «Маргарита 25» не должен остаться живым вариантом: %+v", state.Variants)
	}
}

// TestMenuAttributes_ScaleLinkedRejectsExplicitValues — атрибут не может
// одновременно ссылаться на шкалу и приносить свои values (неоднозначность
// источника истины).
func TestMenuAttributes_ScaleLinkedRejectsExplicitValues(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	scale := createSizeScale(t, f, tok, "Пиццы 25/30", "25", "30")
	product := createAttrProduct(t, f, tok, "Гавайская", nil)
	pid := product["id"].(string)

	r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), map[string]any{
		"attributes": []map[string]any{
			{"name": "Размер", "size_scale_id": scale.ID, "values": []map[string]any{{"label": "25"}}},
		},
	})
	if r.StatusCode != http.StatusBadRequest {
		t.Fatalf("ожидали 400 (values + size_scale_id несовместимы), получили %d %s", r.StatusCode, b)
	}
}

// varBackingUnit — небольшой помощник: вернуть *string или "".
func strOr(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

// TestMenuAttributes_ConvertToPurchasedBacksEachVariant — конвертация блюда с
// вариациями в «Покупной» должна завести склад КАЖДОМУ варианту (свой SKU и
// остаток на складе «Покупные»), пометить вариации is_purchased, а фантом-
// ингредиент родителя-контейнера снять. Регресс: раньше склад получала только
// «группа»-родитель, вариации оставались без остатка (напитки «по объёмам»).
func TestMenuAttributes_ConvertToPurchasedBacksEachVariant(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// 1) обычное (НЕ покупное) блюдо с двумя вариациями
	product := createAttrProduct(t, f, tok, "Фанта", nil)
	pid := product["id"].(string)
	create := map[string]any{
		"attributes": []map[string]any{
			{"name": "Объём", "values": []map[string]any{{"label": "0.5 л"}, {"label": "1 л"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"0.5 л"}, "price": "6"},
			{"labels": []string{"1 л"}, "price": "9"},
		},
	}
	if r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), create); r.StatusCode != http.StatusOK {
		t.Fatalf("PUT attributes: %d %s", r.StatusCode, b)
	}

	// 2) конвертация в покупной
	if r, b := f.patch(t, "/api/v1/menu/items/"+pid, tok, uuid.NewString(), map[string]any{
		"is_purchased": true, "purchase_price": "5", "purchase_unit": "шт",
	}); r.StatusCode != http.StatusOK {
		t.Fatalf("patch purchased: %d %s", r.StatusCode, b)
	}

	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if s, e := gdb.DB(); e == nil {
			_ = s.Close()
		}
	})

	var variants []models.MenuItem
	if err := gdb.Where("parent_id = ? AND is_deleted = ?", pid, false).Find(&variants).Error; err != nil {
		t.Fatal(err)
	}
	if len(variants) != 2 {
		t.Fatalf("ожидали 2 вариации, получили %d", len(variants))
	}
	for _, v := range variants {
		nm := strOr(v.Name)
		if !v.IsPurchased {
			t.Errorf("вариация %q осталась НЕ покупной", nm)
		}
		var line models.TechCardLine
		if err := gdb.Where("menu_item_id = ?", v.ID).First(&line).Error; err != nil {
			t.Fatalf("вариация %q без техкарты (нет своего склада): %v", nm, err)
		}
		if line.IngredientID == nil {
			t.Fatalf("вариация %q: техкарта без ingredient_id", nm)
		}
		var ing models.Ingredient
		if err := gdb.Where("id = ?", *line.IngredientID).First(&ing).Error; err != nil {
			t.Fatalf("вариация %q: ингредиент не найден: %v", nm, err)
		}
		if ing.WarehouseID == nil {
			t.Errorf("вариация %q: ингредиент вне склада", nm)
		} else {
			var w models.Warehouse
			if err := gdb.Where("id = ?", *ing.WarehouseID).First(&w).Error; err == nil && strOr(w.Kind) != "purchased" {
				t.Errorf("вариация %q: склад %q, ожидали purchased", nm, strOr(w.Kind))
			}
		}
	}

	// Родитель-контейнер: фантома быть не должно (ни техкарты, ни ингредиента «Фанта»).
	var parentLines int64
	gdb.Model(&models.TechCardLine{}).Where("menu_item_id = ?", pid).Count(&parentLines)
	if parentLines != 0 {
		t.Errorf("у родителя-контейнера осталась техкарта-фантом: %d строк", parentLines)
	}
	var phantom int64
	gdb.Model(&models.Ingredient{}).Where("restaurant_id = ? AND name = ?", f.rid, "Фанта").Count(&phantom)
	if phantom != 0 {
		t.Errorf("остался фантом-ингредиент «Фанта»: %d", phantom)
	}
}

// TestMenuAttributes_PurchasedProductNoParentPhantom — покупной продукт,
// созданный сразу с вариациями (флоу «новый товар»), не должен оставлять
// backing-ингредиент у родителя-контейнера: склад только у вариантов.
func TestMenuAttributes_PurchasedProductNoParentPhantom(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	product := createAttrProduct(t, f, tok, "Кола", map[string]any{
		"is_purchased": true, "purchase_price": "5", "purchase_unit": "шт",
	})
	pid := product["id"].(string)
	create := map[string]any{
		"attributes": []map[string]any{
			{"name": "Объём", "values": []map[string]any{{"label": "0.5 л"}, {"label": "1 л"}}},
		},
		"combos": []map[string]any{
			{"labels": []string{"0.5 л"}, "price": "6", "purchase_price": "4"},
			{"labels": []string{"1 л"}, "price": "9", "purchase_price": "6"},
		},
	}
	if r, b := f.put(t, "/api/v1/menu/items/"+pid+"/attributes", tok, uuid.NewString(), create); r.StatusCode != http.StatusOK {
		t.Fatalf("PUT attributes: %d %s", r.StatusCode, b)
	}

	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if s, e := gdb.DB(); e == nil {
			_ = s.Close()
		}
	})

	// Родитель: ни техкарты, ни фантома-ингредиента «Кола» (варианты — «Кола 0.5 л» и т.п.).
	var parentLines int64
	gdb.Model(&models.TechCardLine{}).Where("menu_item_id = ?", pid).Count(&parentLines)
	if parentLines != 0 {
		t.Errorf("фантом-техкарта родителя не снята: %d строк", parentLines)
	}
	var phantom int64
	gdb.Model(&models.Ingredient{}).Where("restaurant_id = ? AND name = ?", f.rid, "Кола").Count(&phantom)
	if phantom != 0 {
		t.Errorf("остался фантом-ингредиент «Кола»: %d", phantom)
	}

	// Каждая вариация — свой backing на складе.
	var variants []models.MenuItem
	gdb.Where("parent_id = ? AND is_deleted = ?", pid, false).Find(&variants)
	if len(variants) != 2 {
		t.Fatalf("ожидали 2 вариации, получили %d", len(variants))
	}
	for _, v := range variants {
		var line models.TechCardLine
		if err := gdb.Where("menu_item_id = ?", v.ID).First(&line).Error; err != nil || line.IngredientID == nil {
			t.Errorf("вариация %q без своего склада: %v", strOr(v.Name), err)
		}
	}
}
