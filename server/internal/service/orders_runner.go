package service

import (
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/escpos"
)

// loadOrderPrintMeta — догружает имена стола, зоны и официанта/кассира для
// печати. Все поля опциональны: при отсутствии данных возвращаются пустые
// строки. Один общий хелпер используется и для runner'а, и для receipt/pre-bill.
type orderPrintMeta struct {
	TableLabel  string // "Стол №3" или просто Name стола ("VIP-1")
	ZoneName    string // имя зоны (если есть)
	WaiterName  string
	CashierName string
	GuestsCount int
}

func loadOrderPrintMeta(tx *gorm.DB, order *models.Order, withCashier bool) orderPrintMeta {
	var m orderPrintMeta
	if order.TableID != nil && *order.TableID != "" {
		var t models.Table
		if err := tx.Where("id = ?", *order.TableID).First(&t).Error; err == nil {
			m.TableLabel = formatTableLabel(&t)
			if t.ZoneID != nil && *t.ZoneID != "" {
				var z models.Zone
				if err := tx.Where("id = ?", *t.ZoneID).First(&z).Error; err == nil {
					m.ZoneName = z.Name
				}
			}
		}
	}
	if order.WaiterID != nil && *order.WaiterID != "" {
		var u models.User
		if err := tx.Where("id = ?", *order.WaiterID).First(&u).Error; err == nil {
			if u.Name != nil {
				m.WaiterName = *u.Name
			}
		}
	}
	if withCashier && order.CashierID != nil && *order.CashierID != "" {
		var u models.User
		if err := tx.Where("id = ?", *order.CashierID).First(&u).Error; err == nil {
			if u.Name != nil {
				m.CashierName = *u.Name
			}
		}
	}
	if order.GuestsCount != nil {
		m.GuestsCount = *order.GuestsCount
	}
	return m
}

// formatTableLabel — порт v1-логики:
//
//	tableName ? (startsWith("стол") ? tableName : "Стол " + tableName) : ""
//
// В v4 у Table есть Name (свободная строка типа "VIP-1") и Number. Если
// Name указан — используем его, иначе строим из Number.
func formatTableLabel(t *models.Table) string {
	if t == nil {
		return ""
	}
	if t.Name != nil && *t.Name != "" {
		nm := *t.Name
		if strings.HasPrefix(strings.ToLower(nm), "стол") {
			return nm
		}
		return "Стол " + nm
	}
	if t.Number != nil {
		return "Стол №" + intToStr(*t.Number)
	}
	return ""
}

// joinNonEmpty — соединяет непустые значения через sep (v1: filter(Boolean).join(", ")).
func joinNonEmpty(sep string, parts ...string) string {
	out := make([]string, 0, len(parts))
	for _, p := range parts {
		if p != "" {
			out = append(out, p)
		}
	}
	return strings.Join(out, sep)
}

// orderTypeLabel — "Зал" / "Доставка" / "Самовывоз".
func orderTypeLabel(order *models.Order) string {
	if order == nil || order.Type == nil {
		return "Зал"
	}
	switch *order.Type {
	case "delivery":
		return "Доставка"
	case "takeaway":
		return "Самовывоз"
	default:
		return "Зал"
	}
}

// StationResolver — лёгкий interface, подменяемый для тестов.
//
// Реализуется printer.DBRouter. Сервис не знает про printer напрямую, чтобы не
// циклить пакеты.
//
//   - ResolveByStation — id ВКЛЮЧЁННОГО принтера станции (ok=false, если нет).
//   - StationHasPrinter — есть ли у станции принтер ВООБЩЕ (любой enabled).
//     Нужно различать «станция настроена, но её принтер отключён» (→ бесбумажная,
//     печатать НЕ надо, повар видит на KDS) и «у станции нет своего принтера»
//     (→ как раньше, задание без printer_id уходит на общий станционный принтер).
type StationResolver interface {
	ResolveByStation(restaurantID, station string) (string, bool)
	StationHasPrinter(restaurantID, station string) bool
}

// WithStationResolver — fluent setter (как WithPublisher).
func (s *OrdersService) WithStationResolver(r StationResolver) *OrdersService {
	s.stations = r
	return s
}

// isFastFood — ресторан работает без столов (041, tables_enabled=false): гость
// забирает заказ по номеру. Включает крупный номер заказа в чеке и ранере
// (escpos: FontBig 6×) — гость читает своё число через зал, повар собирает
// заказ по нему. В зале с официантами номер гостю не нужен.
func isFastFood(rest models.Restaurant) bool {
	return rest.TablesEnabled != nil && !*rest.TablesEnabled
}

// kitchenOnPay — фастфуд-режим ресторана (restaurants.kitchen_on_pay, 041).
// true → кухонный бегунок печатается на ОПЛАТЕ (orders_close.Close), а не при
// создании/дозаказе (orders_write). false (дефолт) → классический table-service:
// кухня сразу на «Отправить», оплата потом.
//
// Ошибку чтения трактуем как false — безопаснее напечатать бегунок как обычно,
// чем молча не отправить заказ на кухню.
func (s *OrdersService) kitchenOnPay(tx *gorm.DB, restaurantID string) bool {
	var on bool
	if err := tx.Model(&models.Restaurant{}).
		Select("COALESCE(kitchen_on_pay, false)").
		Where("id = ?", restaurantID).
		Scan(&on).Error; err != nil {
		return false
	}
	return on
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

	// Группируем items по station. Печатаем полную qty каждой строки —
	// merge не сливается с уже-напечатанными рядами (см. loadMergeableItems
	// фильтр `printed_at IS NULL`), поэтому здесь не нужно учитывать
	// qty_printed. printedItemIDs — id строк, чтобы проставить
	// printed_at/qty_printed после успешной постановки job'а.
	byStation := make(map[string][]models.OrderItem)
	printedItemIDs := make([]string, 0, len(items))
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
	if len(byStation) == 0 {
		return nil
	}

	// Имя ресторана для шапки (опц.).
	var rest models.Restaurant
	_ = tx.Where("id = ?", restaurantID).First(&rest).Error

	// Подгружаем стол / зону / официанта / гостей — повару нужен контекст
	// (без этого блока v2.0.92 печатал runner без стола и без имени официанта).
	meta := loadOrderPrintMeta(tx, order, false)
	zoneLabel := meta.ZoneName
	typeLbl := orderTypeLabel(order)
	if zoneLabel == "" && order.Type != nil && *order.Type != "hall" {
		zoneLabel = typeLbl
	}
	guestsLabel := ""
	if meta.GuestsCount > 0 {
		guestsLabel = intToStr(meta.GuestsCount) + " гост."
	}
	runnerTableLabel := joinNonEmpty(", ", meta.TableLabel, zoneLabel, guestsLabel)

	for station, sItems := range byStation {
		// Резолвим принтер станции. Если станция настроена, но её принтер(ы)
		// ОТКЛЮЧЕНЫ — она бесбумажная (повар видит позиции на KDS): бегунок не
		// печатаем и строки НЕ помечаем напечатанными. Если у станции нет своего
		// принтера — как раньше: job без printer_id уходит на общий станционный.
		var printerID *string
		if s.stations != nil {
			if pid, ok := s.stations.ResolveByStation(restaurantID, station); ok {
				printerID = &pid
			} else if s.stations.StationHasPrinter(restaurantID, station) {
				continue
			}
		}

		in := escpos.RunnerInput{
			Station:     stationLabel(station),
			FastFood:    isFastFood(rest),
			OrderNumber: order.OrderNumber,
			TableLabel:  runnerTableLabel,
			WaiterName:  meta.WaiterName,
			CreatedAt:   now,
		}
		// Группируем одинаковые весовые порции в одну строку «100г × 3».
		// Unit берём из order_item (бэкенд всегда проставляет его из меню).
		for _, g := range groupPrintItems(sItems) {
			ri := escpos.RunnerItem{
				Name:    g.Name,
				Comment: g.Note,
				QtyDec:  g.Qty,
				Unit:    g.Unit,
				Count:   g.Count,
			}
			f, _ := g.Qty.Float64()
			ri.Qty = int(f)
			if ri.Qty < 1 {
				ri.Qty = 1
			}
			in.Items = append(in.Items, ri)
		}
		payload := escpos.RunnerLayout(in)

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
		// Помечаем только строки реально напечатанных станций.
		for _, it := range sItems {
			printedItemIDs = append(printedItemIDs, it.ID)
		}
	}
	// Помечаем строки как «полностью отданные повару» (qty_printed = qty).
	// printed_at ставим, если ещё не стоял — он остаётся timestamp'ом ПЕРВОЙ
	// печати на runner (его читают legacy-консьюмеры).
	if len(printedItemIDs) > 0 {
		if err := tx.Exec(`
			UPDATE order_items
			   SET qty_printed = qty,
			       printed_at = COALESCE(printed_at, ?),
			       updated_at = ?
			 WHERE id IN ?
		`, now, now, printedItemIDs).Error; err != nil {
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

	// Стол / зона / официант — повар должен сразу видеть, чей заказ отменяется.
	meta := loadOrderPrintMeta(tx, order, false)
	cancelTableLabel := joinNonEmpty(", ", meta.TableLabel, meta.ZoneName)

	for station, sItems := range byStation {
		// Отключённая станция бесбумажная — «ОТМЕНА» на неё тоже не печатаем.
		var printerID *string
		if s.stations != nil {
			if pid, ok := s.stations.ResolveByStation(restaurantID, station); ok {
				printerID = &pid
			} else if s.stations.StationHasPrinter(restaurantID, station) {
				continue
			}
		}
		in := escpos.CancelRunnerInput{
			Station:     stationLabel(station),
			OrderNumber: order.OrderNumber,
			TableLabel:  cancelTableLabel,
			WaiterName:  meta.WaiterName,
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
			ri.QtyDec = it.Qty
			if it.MenuItemID != nil {
				if mi, ok := miByID[*it.MenuItemID]; ok && mi.Unit != nil {
					ri.Unit = *mi.Unit
				}
			}
			in.Items = append(in.Items, ri)
		}
		payload := escpos.CancelRunnerLayout(in)

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
