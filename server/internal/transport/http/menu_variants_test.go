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
