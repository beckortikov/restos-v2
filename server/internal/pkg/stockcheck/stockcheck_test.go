package stockcheck

import (
	"regexp"
	"testing"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Minimal assertions on stdlib testing.
type require struct{}

var R = require{}

func (require) Len(t *testing.T, s []string, n int) {
	t.Helper()
	if len(s) != n {
		t.Fatalf("expected len=%d, got %d: %v", n, len(s), s)
	}
}
func (require) Empty(t *testing.T, s []string) {
	t.Helper()
	if len(s) != 0 {
		t.Fatalf("expected empty, got %v", s)
	}
}
func (require) NotEmpty(t *testing.T, s []string) {
	t.Helper()
	if len(s) == 0 {
		t.Fatalf("expected non-empty, got empty slice")
	}
}
func (require) Regexp(t *testing.T, pattern, s string) {
	t.Helper()
	re := regexp.MustCompile(pattern)
	if !re.MatchString(s) {
		t.Fatalf("expected %q to match /%s/", s, pattern)
	}
}

// Helpers — повторяют v1 stock-check.test.ts (lib/stock-check.test.ts).

// ing — builder для IngredientInfo c is_food=true. Дефолтный name="ing".
func ing(qty, waste decimal.Decimal, name string) *IngredientInfo {
	if name == "" {
		name = "ing"
	}
	return &IngredientInfo{
		Qty:          qty,
		WastePercent: waste,
		Name:         name,
		IsFood:       true,
	}
}

// ingNonFood — для теста is_food=false (qty=0, чтобы убедиться что non-food пропускается).
func ingNonFood(name string) *IngredientInfo {
	return &IngredientInfo{
		Qty:    decimal.Zero,
		Name:   name,
		IsFood: false,
	}
}

func strPtr(s string) *string { return &s }

// ─── 'tech-card-only' (techCards ON, strict OFF) ──────────────────────────

func TestComputeShortages_TechCardOnly(t *testing.T) {
	t.Run("blocks dish without tech-card lines", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Кока-кола", Qty: decimal.FromInt(1)}},
			Opts{
				Mode:      ModeTechCardOnly,
				MenuByID:  map[string]MenuMeta{"d1": {}},
				TclByMenu: map[string][]TechLine{},
			},
		)
		R.Len(t, r, 1)
		R.Regexp(t, "не настроена техкарта", r[0])
	})

	t.Run("blocks dish whose tech-card lines all have ingredient_id=NULL", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Блюдо", Qty: decimal.FromInt(1)}},
			Opts{
				Mode:     ModeTechCardOnly,
				MenuByID: map[string]MenuMeta{"d1": {}},
				TclByMenu: map[string][]TechLine{
					"d1": {{IngredientID: nil, Qty: decimal.FromInt(100), Name: "free-line", Ingredient: nil}},
				},
			},
		)
		R.Len(t, r, 1)
		R.Regexp(t, "не настроена техкарта", r[0])
	})

	t.Run("passes when tech card exists, EVEN at zero stock (negative allowed)", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Курица", Qty: decimal.FromInt(1)}},
			Opts{
				Mode:     ModeTechCardOnly,
				MenuByID: map[string]MenuMeta{"d1": {}},
				TclByMenu: map[string][]TechLine{
					"d1": {{
						IngredientID: strPtr("i1"),
						Qty:          decimal.FromInt(100),
						Name:         "Куриное филе",
						Ingredient:   ing(decimal.Zero, decimal.Zero, ""),
					}},
				},
			},
		)
		R.Empty(t, r)
	})

	t.Run("passes batch dish even if prepared_qty=0 (negative allowed in non-strict)", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Плов", Qty: decimal.FromInt(3)}},
			Opts{
				Mode:     ModeTechCardOnly,
				MenuByID: map[string]MenuMeta{"d1": {IsBatchCooking: true, PreparedQty: 0}},
				TclByMenu: map[string][]TechLine{
					"d1": {{
						IngredientID: strPtr("i1"),
						Qty:          decimal.FromInt(100),
						Name:         "Рис",
						Ingredient:   ing(decimal.FromInt(9999), decimal.Zero, "Рис"),
					}},
				},
			},
		)
		R.Empty(t, r)
	})
}

// ─── 'strict' (techCards ON, strict ON) ─────────────────────────────────────

func TestComputeShortages_Strict(t *testing.T) {
	t.Run("blocks dish without tech card (rule 1 still applies)", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Кока-кола", Qty: decimal.FromInt(1)}},
			Opts{
				Mode:      ModeStrict,
				MenuByID:  map[string]MenuMeta{"d1": {}},
				TclByMenu: map[string][]TechLine{},
			},
		)
		R.Len(t, r, 1)
		R.Regexp(t, "не настроена техкарта", r[0])
	})

	t.Run("blocks when stock < needed", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Курица", Qty: decimal.FromInt(1)}},
			Opts{
				Mode:     ModeStrict,
				MenuByID: map[string]MenuMeta{"d1": {}},
				TclByMenu: map[string][]TechLine{
					"d1": {{
						IngredientID: strPtr("i1"),
						Qty:          decimal.FromInt(100),
						Name:         "Куриное филе",
						Ingredient:   ing(decimal.Zero, decimal.Zero, "Куриное филе"),
					}},
				},
			},
		)
		R.Len(t, r, 1)
		R.Regexp(t, "Куриное филе", r[0])
	})

	t.Run("passes when stock is sufficient", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Курица", Qty: decimal.FromInt(1)}},
			Opts{
				Mode:     ModeStrict,
				MenuByID: map[string]MenuMeta{"d1": {}},
				TclByMenu: map[string][]TechLine{
					"d1": {{
						IngredientID: strPtr("i1"),
						Qty:          decimal.FromInt(100),
						Name:         "Куриное филе",
						Ingredient:   ing(decimal.FromInt(500), decimal.Zero, "Куриное филе"),
					}},
				},
			},
		)
		R.Empty(t, r)
	})

	t.Run("accounts for waste_percent", func(t *testing.T) {
		// 100г + 20% waste => 125г needed, stock=120 → shortage
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Курица", Qty: decimal.FromInt(1)}},
			Opts{
				Mode:     ModeStrict,
				MenuByID: map[string]MenuMeta{"d1": {}},
				TclByMenu: map[string][]TechLine{
					"d1": {{
						IngredientID: strPtr("i1"),
						Qty:          decimal.FromInt(100),
						Name:         "Куриное филе",
						Ingredient:   ing(decimal.FromInt(120), decimal.FromInt(20), "Куриное филе"),
					}},
				},
			},
		)
		R.Len(t, r, 1)
	})

	t.Run("skips non-food ingredients (is_food=false)", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Блюдо", Qty: decimal.FromInt(1)}},
			Opts{
				Mode:     ModeStrict,
				MenuByID: map[string]MenuMeta{"d1": {}},
				TclByMenu: map[string][]TechLine{
					"d1": {{
						IngredientID: strPtr("i1"),
						Qty:          decimal.FromInt(1),
						Name:         "Упаковка",
						Ingredient:   ingNonFood("Упаковка"),
					}},
				},
			},
		)
		R.Empty(t, r)
	})

	t.Run("batch dish: blocks when prepared_qty < requested", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Плов", Qty: decimal.FromInt(3)}},
			Opts{
				Mode:     ModeStrict,
				MenuByID: map[string]MenuMeta{"d1": {IsBatchCooking: true, PreparedQty: 2}},
				TclByMenu: map[string][]TechLine{
					"d1": {{
						IngredientID: strPtr("i1"),
						Qty:          decimal.FromInt(100),
						Name:         "Рис",
						Ingredient:   ing(decimal.FromInt(9999), decimal.Zero, "Рис"),
					}},
				},
			},
		)
		R.Len(t, r, 1)
		R.Regexp(t, "готово 2", r[0])
	})

	t.Run("race: reservedByIngredient blocks the second order on the last portion", func(t *testing.T) {
		baseOpts := Opts{
			Mode:     ModeStrict,
			MenuByID: map[string]MenuMeta{"d1": {}},
			TclByMenu: map[string][]TechLine{
				"d1": {{
					IngredientID: strPtr("i1"),
					Qty:          decimal.FromInt(100),
					Name:         "Куриное филе",
					Ingredient:   ing(decimal.FromInt(100), decimal.Zero, "Куриное филе"),
				}},
			},
		}
		// Order A: свежий stock, без reservations → passes.
		a := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Курица", Qty: decimal.FromInt(1)}},
			baseOpts,
		)
		R.Empty(t, a)

		// Order B: 100г уже зарезервированы → blocked.
		optsB := baseOpts
		optsB.ReservedByIngredient = map[string]decimal.Decimal{"i1": decimal.FromInt(100)}
		b := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Курица", Qty: decimal.FromInt(1)}},
			optsB,
		)
		R.Len(t, b, 1)
		R.Regexp(t, "нет на складе", b[0])
	})

	t.Run("race (batch): reservedBatchByMenu blocks oversell of prepared portions", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Плов", Qty: decimal.FromInt(1)}},
			Opts{
				Mode:     ModeStrict,
				MenuByID: map[string]MenuMeta{"d1": {IsBatchCooking: true, PreparedQty: 2}},
				TclByMenu: map[string][]TechLine{
					"d1": {{
						IngredientID: strPtr("i1"),
						Qty:          decimal.FromInt(100),
						Name:         "Рис",
						Ingredient:   ing(decimal.FromInt(9999), decimal.Zero, "Рис"),
					}},
				},
				ReservedBatchByMenu: map[string]decimal.Decimal{"d1": decimal.FromInt(2)},
			},
		)
		R.Len(t, r, 1)
	})
}

// ─── Regression: «no tech card => silently pass» bug GONE ────────────────────

func TestComputeShortages_Regression_NoTechCardNeverPasses(t *testing.T) {
	t.Run("strict mode never silently passes a dish without tech card", func(t *testing.T) {
		r := ComputeShortages(
			[]OrderItem{{MenuItemID: "d1", Name: "Без техкарты", Qty: decimal.FromInt(5)}},
			Opts{
				Mode:      ModeStrict,
				MenuByID:  map[string]MenuMeta{"d1": {}},
				TclByMenu: map[string][]TechLine{},
			},
		)
		R.NotEmpty(t, r)
	})
}
