package service

import (
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/escpos"
)

// StationResolver — лёгкий interface, подменяемый для тестов.
//
// Реализуется printer.DBRouter.ResolveByStation. Сервис не знает про printer
// напрямую, чтобы не циклить пакеты.
type StationResolver interface {
	ResolveByStation(restaurantID, station string) (string, bool)
}

// WithStationResolver — fluent setter (как WithPublisher).
func (s *OrdersService) WithStationResolver(r StationResolver) *OrdersService {
	s.stations = r
	return s
}

// enqueueRunners группирует новые items по station и создаёт runner-print_jobs
// по одному на station. printer_id заполняется через StationResolver — если
// принтер не настроен, job создаётся без printer_id и попадёт в "failed"
// при первом tick worker'а (это лучше, чем тихая потеря).
//
// Вызывается из Create и AddItems после успешной записи items.
//
// items — те, для которых надо напечатать ranner (свежесозданные).
func (s *OrdersService) enqueueRunners(tx *gorm.DB, restaurantID string, order *models.Order, items []models.OrderItem, now time.Time) error {
	if len(items) == 0 {
		return nil
	}
	// Грузим menu_items одним запросом — нужны station + name.
	menuIDs := make([]string, 0, len(items))
	for _, it := range items {
		if it.MenuItemID != nil {
			menuIDs = append(menuIDs, *it.MenuItemID)
		}
	}
	if len(menuIDs) == 0 {
		return nil
	}
	var mis []models.MenuItem
	if err := tx.Where("id IN ?", menuIDs).Find(&mis).Error; err != nil {
		return err
	}
	miByID := make(map[string]models.MenuItem, len(mis))
	for _, m := range mis {
		miByID[m.ID] = m
	}

	// Группируем items по station.
	byStation := make(map[string][]models.OrderItem)
	for _, it := range items {
		if it.MenuItemID == nil {
			continue
		}
		mi, ok := miByID[*it.MenuItemID]
		if !ok {
			continue
		}
		station := "hot_kitchen"
		if mi.Station != nil && *mi.Station != "" {
			station = *mi.Station
		}
		byStation[station] = append(byStation[station], it)
	}

	// Имя ресторана для шапки (опц.).
	var rest models.Restaurant
	_ = tx.Where("id = ?", restaurantID).First(&rest).Error

	tableLabel := ""
	if order.TableID != nil {
		// Без JOIN — фронт сам нарисует «Стол №X», а нам нужен printable label.
		tableLabel = "Заказ #" + intToStr(order.OrderNumber)
	}

	for station, sItems := range byStation {
		in := escpos.RunnerInput{
			Station:     stationLabel(station),
			OrderNumber: order.OrderNumber,
			TableLabel:  tableLabel,
			CreatedAt:   now,
		}
		for _, it := range sItems {
			ri := escpos.RunnerItem{}
			if it.Name != nil {
				ri.Name = *it.Name
			}
			if it.Note != nil {
				ri.Comment = *it.Note
			}
			f, _ := it.Qty.Float64()
			ri.Qty = int(f)
			if ri.Qty < 1 {
				ri.Qty = 1
			}
			in.Items = append(in.Items, ri)
		}
		payload := escpos.RunnerLayout(in)

		var printerID *string
		if s.stations != nil {
			if pid, ok := s.stations.ResolveByStation(restaurantID, station); ok {
				printerID = &pid
			}
		}
		job := &models.PrintJob{
			ID:           uuid.NewString(),
			Type:         "runner",
			PrinterID:    printerID,
			Payload:      payload,
			OrderID:      &order.ID,
			Status:       "pending",
			RestaurantID: &restaurantID,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Session(&gorm.Session{SkipHooks: true}).Create(job).Error; err != nil {
			return err
		}
	}
	return nil
}

// enqueueCancelRunners печатает "ОТМЕНА" на station-принтерах для items,
// которые были отменены. Группирует по station так же, как enqueueRunners.
//
// reason — общий повод для всех items (например "клиент отказался" при cancel
// order, или конкретная причина void).
func (s *OrdersService) enqueueCancelRunners(tx *gorm.DB, restaurantID string, order *models.Order, items []models.OrderItem, reason string, now time.Time) error {
	if len(items) == 0 {
		return nil
	}
	menuIDs := make([]string, 0, len(items))
	for _, it := range items {
		if it.MenuItemID != nil {
			menuIDs = append(menuIDs, *it.MenuItemID)
		}
	}
	if len(menuIDs) == 0 {
		return nil
	}
	var mis []models.MenuItem
	if err := tx.Where("id IN ?", menuIDs).Find(&mis).Error; err != nil {
		return err
	}
	miByID := make(map[string]models.MenuItem, len(mis))
	for _, m := range mis {
		miByID[m.ID] = m
	}

	byStation := make(map[string][]models.OrderItem)
	for _, it := range items {
		if it.MenuItemID == nil {
			continue
		}
		mi, ok := miByID[*it.MenuItemID]
		if !ok {
			continue
		}
		station := "hot_kitchen"
		if mi.Station != nil && *mi.Station != "" {
			station = *mi.Station
		}
		byStation[station] = append(byStation[station], it)
	}

	tableLabel := ""
	if order.TableID != nil {
		tableLabel = "Заказ #" + intToStr(order.OrderNumber)
	}

	for station, sItems := range byStation {
		in := escpos.CancelRunnerInput{
			Station:     stationLabel(station),
			OrderNumber: order.OrderNumber,
			TableLabel:  tableLabel,
			CancelledAt: now,
			Reason:      reason,
		}
		for _, it := range sItems {
			ri := escpos.RunnerItem{}
			if it.Name != nil {
				ri.Name = *it.Name
			}
			if it.Note != nil {
				ri.Comment = *it.Note
			}
			f, _ := it.Qty.Float64()
			ri.Qty = int(f)
			if ri.Qty < 1 {
				ri.Qty = 1
			}
			in.Items = append(in.Items, ri)
		}
		payload := escpos.CancelRunnerLayout(in)

		var printerID *string
		if s.stations != nil {
			if pid, ok := s.stations.ResolveByStation(restaurantID, station); ok {
				printerID = &pid
			}
		}
		job := &models.PrintJob{
			ID:           uuid.NewString(),
			Type:         "cancel_runner",
			PrinterID:    printerID,
			Payload:      payload,
			OrderID:      &order.ID,
			Status:       "pending",
			RestaurantID: &restaurantID,
			CreatedAt:    now,
			UpdatedAt:    now,
		}
		if err := tx.Session(&gorm.Session{SkipHooks: true}).Create(job).Error; err != nil {
			return err
		}
	}
	return nil
}

func intToStr(n int) string {
	if n == 0 {
		return "0"
	}
	neg := n < 0
	if neg {
		n = -n
	}
	digits := []byte{}
	for n > 0 {
		digits = append([]byte{byte('0' + n%10)}, digits...)
		n /= 10
	}
	if neg {
		digits = append([]byte{'-'}, digits...)
	}
	return string(digits)
}

// stationLabel — превращает code в человеческое название для повара.
func stationLabel(s string) string {
	switch s {
	case "hot_kitchen":
		return "Горячий цех"
	case "cold_kitchen":
		return "Холодный цех"
	case "bar":
		return "Бар"
	case "grill":
		return "Гриль"
	case "dessert":
		return "Десерты"
	default:
		return s
	}
}
