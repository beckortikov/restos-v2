package service

import (
	"testing"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

func strp(s string) *string { return &s }

func TestGroupPrintItems_WeightPortionsMergeWithCount(t *testing.T) {
	name, g := strp("Плов"), strp("g")
	price := decimal.MustFromString("350")
	qty := decimal.MustFromString("100")
	items := []models.OrderItem{
		{Name: name, Price: price, Qty: qty, Unit: g},
		{Name: name, Price: price, Qty: qty, Unit: g},
		{Name: name, Price: price, Qty: qty, Unit: g},
	}
	groups := groupPrintItems(items)
	if len(groups) != 1 {
		t.Fatalf("ожидали 1 группу, получили %d", len(groups))
	}
	if groups[0].Count != 3 {
		t.Errorf("Count: ожидали 3, получили %d", groups[0].Count)
	}
	if got := groups[0].LineTotal.String(); got != "105000" {
		t.Errorf("LineTotal: ожидали 105000 (3×350×100), получили %s", got)
	}
}

func TestGroupPrintItems_DifferentWeightsStaySeparate(t *testing.T) {
	name, g := strp("Плов"), strp("g")
	price := decimal.MustFromString("350")
	items := []models.OrderItem{
		{Name: name, Price: price, Qty: decimal.MustFromString("100"), Unit: g},
		{Name: name, Price: price, Qty: decimal.MustFromString("150"), Unit: g},
	}
	if groups := groupPrintItems(items); len(groups) != 2 {
		t.Fatalf("100г и 150г не должны сливаться: получили %d групп", len(groups))
	}
}

// TestGroupPrintItems_PieceMergesByQty — поведение изменено в v3.16.116.
//
// Раньше штучные позиции не группировались вовсе: касса создаёт отдельный
// order_item на каждое добавление, и «Фри Маленький», добавленный дважды,
// печатался кухне двумя строками «x1». Повар считает порции по строкам —
// и промахивается.
func TestGroupPrintItems_PieceMergesByQty(t *testing.T) {
	name, piece := strp("Кола"), strp("piece")
	price := decimal.MustFromString("12")
	items := []models.OrderItem{
		{Name: name, Price: price, Qty: decimal.MustFromString("2"), Unit: piece},
		{Name: name, Price: price, Qty: decimal.MustFromString("1"), Unit: piece},
	}
	groups := groupPrintItems(items)
	if len(groups) != 1 {
		t.Fatalf("одинаковые штучные должны слиться: получили %d групп", len(groups))
	}
	if got := groups[0].Qty.String(); got != "3" {
		t.Errorf("Qty: ожидали 3 (2+1), получили %s", got)
	}
	// Count остаётся 1: у штучных количество несёт сам Qty, а Count в layout'ах
	// печатается как «× N» и дал бы «Кола 3 × 2».
	if groups[0].Count != 1 {
		t.Errorf("Count штучной группы должен остаться 1, получили %d", groups[0].Count)
	}
	if got := groups[0].LineTotal.String(); got != "36" {
		t.Errorf("LineTotal: ожидали 36 (3×12), получили %s", got)
	}
}

// TestGroupPrintItems_PieceDifferentPriceStaySeparate — одна и та же позиция по
// разной цене (скидка на одну строку) не должна схлопываться: иначе в чеке
// исчезнет строка, по которой видно, что цена была другой.
func TestGroupPrintItems_PieceDifferentPriceStaySeparate(t *testing.T) {
	name, piece := strp("Кола"), strp("piece")
	items := []models.OrderItem{
		{Name: name, Price: decimal.MustFromString("12"), Qty: decimal.MustFromString("1"), Unit: piece},
		{Name: name, Price: decimal.MustFromString("10"), Qty: decimal.MustFromString("1"), Unit: piece},
	}
	if groups := groupPrintItems(items); len(groups) != 2 {
		t.Fatalf("разная цена не должна сливаться: получили %d групп", len(groups))
	}
}

// TestGroupPrintItems_PieceDifferentNoteStaySeparate — «без лука» и обычная
// порция это разные задания для повара.
func TestGroupPrintItems_PieceDifferentNoteStaySeparate(t *testing.T) {
	name, piece := strp("Бургер"), strp("piece")
	price := decimal.MustFromString("30")
	items := []models.OrderItem{
		{Name: name, Price: price, Qty: decimal.MustFromString("1"), Unit: piece},
		{Name: name, Price: price, Qty: decimal.MustFromString("1"), Unit: piece, Note: strp("без лука")},
	}
	if groups := groupPrintItems(items); len(groups) != 2 {
		t.Fatalf("разный комментарий не должен сливаться: получили %d групп", len(groups))
	}
}

// TestGroupPrintItems_DifferentBundleGroupsStaySeparate — одинаковый компонент
// («Кола» по той же цене, без комментария) из ДВУХ разных сетов не должен
// слиться в одну строку «Кола x2»: это два разных заказа сета, и итоговый чек
// напечатал бы одну «Кола x2» под ОДНИМ заголовком «Сет», хотя реально это
// компоненты двух разных сетов (или сета и обычной продажи). BundleGroupID
// должен быть частью merge-ключа — без него этот тест ловит регрессию до
// (см. groupWeightPortions/lib/receipt-data.ts на фронте — та же ошибка уже
// была найдена и исправлена там).
func TestGroupPrintItems_DifferentBundleGroupsStaySeparate(t *testing.T) {
	name, piece := strp("Кола"), strp("piece")
	price := decimal.MustFromString("10")
	g1, g2 := strp("bundle-group-1"), strp("bundle-group-2")
	items := []models.OrderItem{
		{Name: name, Price: price, Qty: decimal.MustFromString("1"), Unit: piece, BundleGroupID: g1},
		{Name: name, Price: price, Qty: decimal.MustFromString("1"), Unit: piece, BundleGroupID: g2},
	}
	if groups := groupPrintItems(items); len(groups) != 2 {
		t.Fatalf("компоненты РАЗНЫХ сетов не должны сливаться: получили %d групп", len(groups))
	}
}

// TestGroupPrintItems_BundleVsPlainStaySeparate — тот же компонент («Кола» той
// же ценой), один раз как часть сета, второй раз как обычная продажа — тоже
// не должны слиться, иначе гость увидит «Кола x2» под заголовком «Сет», хотя
// одна из них в сет не входила.
func TestGroupPrintItems_BundleVsPlainStaySeparate(t *testing.T) {
	name, piece := strp("Кола"), strp("piece")
	price := decimal.MustFromString("10")
	items := []models.OrderItem{
		{Name: name, Price: price, Qty: decimal.MustFromString("1"), Unit: piece, BundleGroupID: strp("bundle-group-1")},
		{Name: name, Price: price, Qty: decimal.MustFromString("1"), Unit: piece},
	}
	if groups := groupPrintItems(items); len(groups) != 2 {
		t.Fatalf("сетовая и обычная позиции не должны сливаться: получили %d групп", len(groups))
	}
}
