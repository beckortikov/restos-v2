package service

import (
	"reflect"
	"testing"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// fakeStationResolver — подмена printer.DBRouter для юнит-тестов маршрутизации.
type fakeStationResolver struct {
	routing    map[string]string
	configured bool
}

func (f fakeStationResolver) StationRouting(string) (map[string]string, bool) {
	return f.routing, f.configured
}

func runnerItem(id, menuID string) models.OrderItem {
	mid := menuID
	return models.OrderItem{ID: id, MenuItemID: &mid}
}

func runnerMenuItem(id, station string) models.MenuItem {
	st := station
	return models.MenuItem{ID: id, Station: &st}
}

func itemIDs(items []models.OrderItem) []string {
	ids := make([]string, 0, len(items))
	for _, it := range items {
		ids = append(ids, it.ID)
	}
	return ids
}

// Цехи одного принтера сливаются в одну цель; порядок позиций — порядок
// заказа (не перегруппировка по цехам); цех другого принтера — отдельная цель.
func TestRouteRunnerItemsMergesStationsOfOnePrinter(t *testing.T) {
	s := &OrdersService{stations: fakeStationResolver{
		routing: map[string]string{
			"hot_kitchen":  "kitchen-printer",
			"cold_kitchen": "kitchen-printer",
			"grill":        "kitchen-printer",
			"bar":          "bar-printer",
		},
		configured: true,
	}}
	miByID := map[string]models.MenuItem{
		"pizza": runnerMenuItem("pizza", "hot_kitchen"),
		"salad": runnerMenuItem("salad", "cold_kitchen"),
		"kebab": runnerMenuItem("kebab", "grill"),
		"cola":  runnerMenuItem("cola", "bar"),
	}
	items := []models.OrderItem{
		runnerItem("i1", "pizza"),
		runnerItem("i2", "cola"),
		runnerItem("i3", "salad"),
		runnerItem("i4", "kebab"),
	}

	targets := s.routeRunnerItems("rid", items, miByID)

	if len(targets) != 2 {
		t.Fatalf("targets = %d, want 2", len(targets))
	}
	kitchen := targets[0]
	if kitchen.printerID == nil || *kitchen.printerID != "kitchen-printer" {
		t.Fatalf("kitchen printerID = %v, want kitchen-printer", kitchen.printerID)
	}
	if want := []string{"hot_kitchen", "cold_kitchen", "grill"}; !reflect.DeepEqual(kitchen.stations, want) {
		t.Errorf("kitchen stations = %v, want %v", kitchen.stations, want)
	}
	if got := runnerHeaderLabel(kitchen.stations); got != "КУХНЯ" {
		t.Errorf("header = %q, want КУХНЯ", got)
	}
	// Порядок заказа сохранён, бар выпал в свою цель.
	if want := []string{"i1", "i3", "i4"}; !reflect.DeepEqual(itemIDs(kitchen.items), want) {
		t.Errorf("kitchen items = %v, want %v", itemIDs(kitchen.items), want)
	}

	bar := targets[1]
	if bar.printerID == nil || *bar.printerID != "bar-printer" {
		t.Fatalf("bar printerID = %v, want bar-printer", bar.printerID)
	}
	if got := runnerHeaderLabel(bar.stations); got != "Бар" {
		t.Errorf("bar header = %q, want Бар", got)
	}
	if len(bar.items) != 1 {
		t.Errorf("bar items = %d, want 1", len(bar.items))
	}
}

// Цех без включённого принтера в configured-режиме — бесбумажный: позиции
// не попадают ни в одну цель (бегунок не печатается, KDS их всё равно видит).
func TestRouteRunnerItemsPaperlessStationSkipped(t *testing.T) {
	s := &OrdersService{stations: fakeStationResolver{
		routing:    map[string]string{"hot_kitchen": "kitchen-printer"},
		configured: true,
	}}
	miByID := map[string]models.MenuItem{
		"pizza":    runnerMenuItem("pizza", "hot_kitchen"),
		"icecream": runnerMenuItem("icecream", "showcase"),
		"lemonade": runnerMenuItem("lemonade", "bar"),
	}
	items := []models.OrderItem{
		runnerItem("i1", "pizza"),
		runnerItem("i2", "icecream"),
		runnerItem("i3", "lemonade"),
	}

	targets := s.routeRunnerItems("rid", items, miByID)

	if len(targets) != 1 {
		t.Fatalf("targets = %d, want 1", len(targets))
	}
	if want := []string{"i1"}; !reflect.DeepEqual(itemIDs(targets[0].items), want) {
		t.Errorf("items = %v, want %v", itemIDs(targets[0].items), want)
	}
	if got := runnerHeaderLabel(targets[0].stations); got != "Горячий цех" {
		t.Errorf("header = %q, want Горячий цех", got)
	}
}

// Legacy-режим (привязок нет вовсе): по одной цели на цех, job без printer_id —
// поведение до 053 сохраняется.
func TestRouteRunnerItemsLegacyPerStation(t *testing.T) {
	for name, s := range map[string]*OrdersService{
		"resolver-not-configured": {stations: fakeStationResolver{configured: false}},
		"nil-resolver":            {stations: nil},
	} {
		t.Run(name, func(t *testing.T) {
			miByID := map[string]models.MenuItem{
				"pizza": runnerMenuItem("pizza", "hot_kitchen"),
				"cola":  runnerMenuItem("cola", "bar"),
			}
			items := []models.OrderItem{
				runnerItem("i1", "pizza"),
				runnerItem("i2", "cola"),
				runnerItem("i3", "pizza"),
			}

			targets := s.routeRunnerItems("rid", items, miByID)

			if len(targets) != 2 {
				t.Fatalf("targets = %d, want 2", len(targets))
			}
			if targets[0].printerID != nil || targets[1].printerID != nil {
				t.Errorf("legacy targets must have nil printerID")
			}
			if want := []string{"hot_kitchen"}; !reflect.DeepEqual(targets[0].stations, want) {
				t.Errorf("stations[0] = %v, want %v", targets[0].stations, want)
			}
			if len(targets[0].items) != 2 {
				t.Errorf("hot items = %d, want 2", len(targets[0].items))
			}
			if want := []string{"bar"}; !reflect.DeepEqual(targets[1].stations, want) {
				t.Errorf("stations[1] = %v, want %v", targets[1].stations, want)
			}
		})
	}
}

// Блюдо без станции идёт в hot_kitchen (дефолт, как в KDS и старом коде).
func TestRouteRunnerItemsDefaultStation(t *testing.T) {
	s := &OrdersService{stations: fakeStationResolver{
		routing:    map[string]string{"hot_kitchen": "kitchen-printer"},
		configured: true,
	}}
	miByID := map[string]models.MenuItem{"soup": {ID: "soup"}} // Station nil
	targets := s.routeRunnerItems("rid", []models.OrderItem{runnerItem("i1", "soup")}, miByID)
	if len(targets) != 1 {
		t.Fatalf("targets = %d, want 1", len(targets))
	}
	if want := []string{"hot_kitchen"}; !reflect.DeepEqual(targets[0].stations, want) {
		t.Errorf("stations = %v, want %v", targets[0].stations, want)
	}
}

func TestStationLabelShowcase(t *testing.T) {
	if got := stationLabel("showcase"); got != "Витрина" {
		t.Errorf("stationLabel(showcase) = %q, want Витрина", got)
	}
}
