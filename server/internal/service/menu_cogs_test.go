package service

import (
	"testing"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

func d(s string) decimal.Decimal { return decimal.MustFromString(s) }

func ptr(s string) *string { return &s }

// Базовый случай: 100 г ингредиента по 100/кг → 10. Зеркалит интеграционный
// TestCogs_ComputedFromTechCard (cogs_techcard_test.go).
func TestComputeTechCardCogsPureBasic(t *testing.T) {
	lines := []models.TechCardLine{
		{IngredientID: ptr("ing1"), Qty: d("100"), Unit: ptr("г")},
	}
	convByID := map[string]ingStockConv{
		"ing1": {unit: "кг", pricePerUnit: d("100")},
	}
	res := computeTechCardCogsPure(lines, convByID, nil)
	if !res.total.Equal(d("10")) || res.skipped != 0 {
		t.Fatalf("total=%s skipped=%d, want 10/0", res.total, res.skipped)
	}
}

// waste=20% → расход_брутто 125 г × 100/кг = 12.5.
func TestComputeTechCardCogsPureWaste(t *testing.T) {
	lines := []models.TechCardLine{
		{IngredientID: ptr("ing1"), Qty: d("100"), Unit: ptr("г")},
	}
	convByID := map[string]ingStockConv{
		"ing1": {unit: "кг", pricePerUnit: d("100"), wastePercent: d("20")},
	}
	res := computeTechCardCogsPure(lines, convByID, nil)
	if !res.total.Equal(d("12.5")) {
		t.Fatalf("total=%s, want 12.5 (waste 20%% grossed up)", res.total)
	}
}

// waste_percent >= 100 не должен ломать формулу — divisor<=0 → поправка не
// применяется (та же защита, что и в реальном списании orders_close.go),
// вместо деления на 0/отрицательное.
func TestComputeTechCardCogsPureWasteAtHundred(t *testing.T) {
	lines := []models.TechCardLine{
		{IngredientID: ptr("ing1"), Qty: d("100"), Unit: ptr("г")},
	}
	convByID := map[string]ingStockConv{
		"ing1": {unit: "кг", pricePerUnit: d("100"), wastePercent: d("100")},
	}
	res := computeTechCardCogsPure(lines, convByID, nil)
	if !res.total.Equal(d("10")) {
		t.Fatalf("total=%s, want 10 (waste>=100%% ignored, not Inf/NaN)", res.total)
	}
}

// Несводимые единицы (рецепт в граммах, склад в штуках без unit_weight) —
// строка помечается skipped, а НЕ считается "как есть" (иначе 200 "г" стало
// бы 200 "шт" и умножилось на цену за штуку).
func TestComputeTechCardCogsPureUnconvertibleSkipped(t *testing.T) {
	lines := []models.TechCardLine{
		{IngredientID: ptr("ing1"), Qty: d("200"), Unit: ptr("г")},
	}
	convByID := map[string]ingStockConv{
		"ing1": {unit: "шт", pricePerUnit: d("50")}, // без unitWeight — г и шт несводимы
	}
	res := computeTechCardCogsPure(lines, convByID, nil)
	if res.skipped != 1 {
		t.Fatalf("skipped=%d, want 1", res.skipped)
	}
	if !res.total.IsZero() {
		t.Fatalf("total=%s, want 0 (skipped line contributes nothing, not qty-as-is)", res.total)
	}
}

// Штучный ингредиент С unit_weight — конвертируется через фактор веса, не
// пропускается: банка 340г по 50/шт, рецепт просит 34 г → 0.1 шт × 50 = 5.
func TestComputeTechCardCogsPureUnitWeightFactor(t *testing.T) {
	lines := []models.TechCardLine{
		{IngredientID: ptr("ing1"), Qty: d("34"), Unit: ptr("г")},
	}
	convByID := map[string]ingStockConv{
		"ing1": {unit: "шт", pricePerUnit: d("50"), unitWeight: d("340"), weightUnit: "г"},
	}
	res := computeTechCardCogsPure(lines, convByID, nil)
	if !res.total.Equal(d("5")) || res.skipped != 0 {
		t.Fatalf("total=%s skipped=%d, want 5/0", res.total, res.skipped)
	}
}

// Полуфабрикат, который ни разу не готовили (нет записи в semiByType) —
// вклад строки молча не считается (не помечается skipped — это легитимный
// "пока нет данных", а не ошибка конфигурации тех-карты).
func TestComputeTechCardCogsPureSemiNeverPrepared(t *testing.T) {
	lines := []models.TechCardLine{
		{SemiTypeID: ptr("semi1"), Qty: d("100"), Unit: ptr("г")},
	}
	res := computeTechCardCogsPure(lines, nil, map[string]semiCostInfo{})
	if !res.total.IsZero() || res.skipped != 0 {
		t.Fatalf("total=%s skipped=%d, want 0/0", res.total, res.skipped)
	}
}

// Полуфабрикат с несводимой рецептурной единицей — skipped, не считается
// "как есть".
func TestComputeTechCardCogsPureSemiUnconvertibleSkipped(t *testing.T) {
	lines := []models.TechCardLine{
		{SemiTypeID: ptr("semi1"), Qty: d("2"), Unit: ptr("шт")},
	}
	semiByType := map[string]semiCostInfo{"semi1": {price: d("40"), unit: "кг"}}
	res := computeTechCardCogsPure(lines, nil, semiByType)
	if res.skipped != 1 {
		t.Fatalf("skipped=%d, want 1 (шт incompatible with кг)", res.skipped)
	}
}

// Смешанная тех-карта: ингредиент + п/ф суммируются вместе.
func TestComputeTechCardCogsPureMixed(t *testing.T) {
	lines := []models.TechCardLine{
		{IngredientID: ptr("ing1"), Qty: d("100"), Unit: ptr("г")}, // 10
		{SemiTypeID: ptr("semi1"), Qty: d("0.5"), Unit: ptr("кг")}, // 0.5*40=20
	}
	convByID := map[string]ingStockConv{"ing1": {unit: "кг", pricePerUnit: d("100")}}
	semiByType := map[string]semiCostInfo{"semi1": {price: d("40"), unit: "кг"}}
	res := computeTechCardCogsPure(lines, convByID, semiByType)
	if !res.total.Equal(d("30")) || res.skipped != 0 {
		t.Fatalf("total=%s skipped=%d, want 30/0", res.total, res.skipped)
	}
}

// Ингредиент, для которого не нашлось цены (удалён/не подгружен) — строка
// пропускается без учёта в skipped (её вообще нет в конфигурации, это не
// "плохие единицы", а отсутствующий справочник).
func TestComputeTechCardCogsPureMissingIngredientPrice(t *testing.T) {
	lines := []models.TechCardLine{
		{IngredientID: ptr("ing_missing"), Qty: d("100"), Unit: ptr("г")},
	}
	res := computeTechCardCogsPure(lines, map[string]ingStockConv{}, nil)
	if !res.total.IsZero() || res.skipped != 0 {
		t.Fatalf("total=%s skipped=%d, want 0/0", res.total, res.skipped)
	}
}
