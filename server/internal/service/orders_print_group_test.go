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

func TestGroupPrintItems_PieceNotGrouped(t *testing.T) {
	name, piece := strp("Кола"), strp("piece")
	price := decimal.MustFromString("12")
	items := []models.OrderItem{
		{Name: name, Price: price, Qty: decimal.MustFromString("2"), Unit: piece},
		{Name: name, Price: price, Qty: decimal.MustFromString("1"), Unit: piece},
	}
	groups := groupPrintItems(items)
	if len(groups) != 2 {
		t.Fatalf("штучные не группируются: получили %d групп", len(groups))
	}
	for _, gr := range groups {
		if gr.Count != 1 {
			t.Errorf("штучная группа Count должен быть 1, получили %d", gr.Count)
		}
	}
}
