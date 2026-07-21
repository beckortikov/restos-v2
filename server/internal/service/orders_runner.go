package service

import (
	"slices"
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

// orderTypeLabel — "Зал" / "Доставка" / "С собой".
func orderTypeLabel(order *models.Order) string {
	if order == nil || order.Type == nil {
		return "Зал"
	}
	switch *order.Type {
	case "delivery":
		return "Доставка"
	case "takeaway":
		return "С собой"
	default:
		return "Зал"
	}
}

// StationResolver — лёгкий interface, подменяемый для тестов.
//
// Реализуется printer.DBRouter. Сервис не знает про printer напрямую, чтобы не
// циклить пакеты.
//
// StationRouting возвращает маршрутизацию цехов ресторана (053):
//   - enabled: цех → id включённого принтера, обслуживающего его. Один принтер
//     может обслуживать несколько цехов — их позиции печатаются ОДНИМ бегунком.
//   - configured: есть ли у ресторана привязки цехов вообще (printer_stations,
//     включая отключённые принтеры). configured и цеха нет в enabled →
//     бесбумажный цех: бегунок не печатается, повар видит KDS. !configured →
//     legacy: job без printer_id на каждый цех (воркер найдёт первый
//     станционный принтер).
type StationResolver interface {
	StationRouting(restaurantID string) (enabled map[string]string, configured bool)
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

// kitchenOnPay — «оплата вперёд»: кухонный бегунок печатается на ОПЛАТЕ
// (orders_close.Close), а не при создании/дозаказе (orders_write).
//
// С 052 включается ДВУМЯ способами:
//   - tables_enabled=false — фастфуд. Режим самодостаточен: нет столов →
//     заказ без оплаты не создаётся вовсе, чек и бегунок печатаются вместе
//     по факту оплаты. Отдельного тумблера в настройках больше нет, чтобы
//     нельзя было выставить противоречивую комбинацию («фастфуд, но кухня
//     печатает до оплаты»).
//   - kitchen_on_pay=true — старый флаг из 041. Оставлен ради существующих
//     конфигов: ресторан со столами мог включить предоплату отдельно.
//
// Ошибку чтения трактуем как false — безопаснее напечатать бегунок как обычно,
// чем молча не отправить заказ на кухню.
func (s *OrdersService) kitchenOnPay(tx *gorm.DB, restaurantID string) bool {
	var on bool
	if err := tx.Model(&models.Restaurant{}).
		Select("COALESCE(kitchen_on_pay, false) OR NOT COALESCE(tables_enabled, true)").
		Where("id = ?", restaurantID).
		Scan(&on).Error; err != nil {
		return false
	}
	return on
}

// deliveryContactsRequired — restaurants.delivery_contacts_required (052).
// true (дефолт) → перед оплатой заказа-доставки касса обязана прислать телефон
// и адрес. Ресторан, который развозит по своим каналам и контакты в кассе не
// ведёт, выключает настройку.
//
// Ошибку чтения трактуем как false — не блокировать оплату на кассе из-за
// сбоя чтения настройки. Пропущенный адрес чинится звонком, заблокированная
// касса — нет.
func (s *OrdersService) deliveryContactsRequired(tx *gorm.DB, restaurantID string) bool {
	var on bool
	if err := tx.Model(&models.Restaurant{}).
		Select("COALESCE(delivery_contacts_required, true)").
		Where("id = ?", restaurantID).
		Scan(&on).Error; err != nil {
		return false
	}
	return on
}

// receiptPrinterFor — конфиг чекового принтера ресторана (кодовая страница,
// ширина ленты, флаги содержимого). Второй результат — нашёлся ли принтер.
//
// Вынесен в общий хелпер, потому что путей печати чеков несколько: оплата,
// пре-чек, перепечатка из истории, X/Z-отчёты. Раньше каждый собирал
// ReceiptInput сам, и перепечатка кодовую страницу не проставляла вовсе —
// чек при оплате печатался нормально, а тот же чек из закрытых заказов
// выходил абракадаброй. Одна точка чтения — один шанс забыть, а не пять.
func receiptPrinterFor(tx *gorm.DB, restaurantID string) (models.Printer, bool) {
	var p models.Printer
	ok := tx.Where("restaurant_id = ? AND kind = 'receipt' AND enabled = TRUE", restaurantID).
		Order("is_default DESC, created_at ASC").First(&p).Error == nil
	return p, ok
}

// applyPrinterToReceipt переносит настройки принтера в макет чека.
func applyPrinterToReceipt(in *escpos.ReceiptInput, p models.Printer) {
	in.Cols = p.Cols
	in.Codepage = byte(p.Codepage)
	in.SuppressLogo = !p.PrintLogo
	in.SuppressDiscount = !p.PrintDiscount
	in.SuppressService = !p.PrintService
	in.ShowTip = p.PrintTip
	in.ShowQRFeedback = p.PrintQRFeedback
}

// runnerTarget — одна цель печати бегунка: принтер (или legacy-цех) и его
// позиции в порядке заказа. Stations — какие цехи попали в цель (для
// заголовка: один цех — его имя, несколько — «КУХНЯ»).
type runnerTarget struct {
	printerID *string
	stations  []string
	items     []models.OrderItem
}

// routeRunnerItems раскладывает позиции по целям печати, сохраняя порядок
// заказа (как пробивал кассир — внутри чека позиции НЕ перегруппировываются
// по цехам, плоским списком).
//
//   - configured-режим (есть printer_stations): цель = принтер; цехи одного
//     принтера сливаются в один бегунок. Цех без включённого принтера —
//     бесбумажный: его позиции не печатаются (и не помечаются printed_at,
//     как и раньше у станций с отключённым принтером).
//   - legacy-режим (привязок нет вовсе): цель = цех, job без printer_id —
//     поведение до 053, воркер резолвит первый станционный принтер.
func (s *OrdersService) routeRunnerItems(restaurantID string, items []models.OrderItem, miByID map[string]models.MenuItem) []runnerTarget {
	var routing map[string]string
	configured := false
	if s.stations != nil {
		routing, configured = s.stations.StationRouting(restaurantID)
	}
	out := []runnerTarget{}
	idx := map[string]int{}
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
		key := "st:" + station
		var printerID *string
		if configured {
			pid, ok := routing[station]
			if !ok {
				continue // бесбумажный цех
			}
			key = "pr:" + pid
			p := pid
			printerID = &p
		}
		i, ok := idx[key]
		if !ok {
			i = len(out)
			idx[key] = i
			out = append(out, runnerTarget{printerID: printerID})
		}
		t := &out[i]
		if !slices.Contains(t.stations, station) {
			t.stations = append(t.stations, station)
		}
		t.items = append(t.items, it)
	}
	return out
}

// runnerHeaderLabel — заголовок бегунка: имя цеха, если цель печатает один
// цех; общий «КУХНЯ», когда принтер собирает несколько цехов в один чек.
func runnerHeaderLabel(stations []string) string {
	if len(stations) == 1 {
		return stationLabel(stations[0])
	}
	return "КУХНЯ"
}

// enqueueRunners раскладывает новые items по целям печати (принтер или
// legacy-цех, см. routeRunnerItems) и создаёт по одному runner-print_job на
// цель. В legacy-режиме job без printer_id попадёт в "failed" при первом tick
// worker'а, если принтеров нет вовсе (это лучше, чем тихая потеря).
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

	// Печатаем полную qty каждой строки — merge не сливается с
	// уже-напечатанными рядами (см. loadMergeableItems фильтр
	// `printed_at IS NULL`), поэтому здесь не нужно учитывать qty_printed.
	// printedItemIDs — id строк, чтобы проставить printed_at/qty_printed
	// после успешной постановки job'а.
	targets := s.routeRunnerItems(restaurantID, items, miByID)
	if len(targets) == 0 {
		return nil
	}
	printedItemIDs := make([]string, 0, len(items))

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

	codepages := printerCodepages(tx, restaurantID)

	for _, t := range targets {
		in := escpos.RunnerInput{
			Station:     runnerHeaderLabel(t.stations),
			Codepage:    codepageOfTarget(codepages, t.printerID),
			FastFood:    isFastFood(rest),
			OrderNumber: order.OrderNumber,
			TableLabel:  runnerTableLabel,
			WaiterName:  meta.WaiterName,
			CreatedAt:   now,
			// Контакты доставки (052) — только для type='delivery'. В фастфуде
			// бегунок ставится на оплате, когда контакты уже заполнены; в
			// table-service бегунок печатается раньше оплаты, и адреса ещё
			// нет — тогда блок просто не печатается.
			DeliveryPhone:   strOrEmpty(order.DeliveryPhone),
			DeliveryAddress: strOrEmpty(order.DeliveryAddress),
		}
		// Группируем одинаковые весовые порции в одну строку «100г × 3».
		// Unit берём из order_item (бэкенд всегда проставляет его из меню).
		for _, g := range groupPrintItems(t.items) {
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
			PrinterID:    t.printerID,
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
		// Помечаем только строки реально напечатанных целей (бесбумажные
		// цехи выпали ещё в routeRunnerItems и остаются ненапечатанными).
		for _, it := range t.items {
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

// printerCodepages — id принтера → его таблица символов (ESC t n).
// Один запрос на весь ресторан: принтеров единицы, а бегунок может уходить
// сразу на несколько, и N+1 здесь был бы бессмысленным.
func printerCodepages(tx *gorm.DB, restaurantID string) map[string]byte {
	out := map[string]byte{}
	var rows []models.Printer
	if err := tx.Where("restaurant_id = ?", restaurantID).Find(&rows).Error; err != nil {
		return out
	}
	for _, p := range rows {
		out[p.ID] = byte(p.Codepage)
	}
	return out
}

// codepageOfTarget — таблица символов цели печати. Пустой printerID (legacy-
// режим без привязок цехов) → 0, и layout подставит дефолт.
func codepageOfTarget(codepages map[string]byte, printerID *string) byte {
	if printerID == nil {
		return 0
	}
	return codepages[*printerID]
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
	// Отменяем только то, что кухня РЕАЛЬНО видела. printed_at проставляется
	// в enqueueRunners после успешной постановки бегунка, поэтому пустой
	// printed_at = позиция на кухню не уходила.
	//
	// Без этого фильтра в фастфуде (бегунок печатается на ОПЛАТЕ) отмена
	// неоплаченного заказа выплёвывала повару «БЛЮДА УДАЛЕНЫ! НЕ ГОТОВИТЬ!»
	// про блюдо, о котором он никогда не слышал: в лучшем случае мусор, в
	// худшем — повар решает, что пропустил заказ, и идёт разбираться.
	// Тот же эффект в зале, если позицию удалили до «Отправить на кухню».
	printed := make([]models.OrderItem, 0, len(items))
	for _, it := range items {
		if it.PrintedAt != nil {
			printed = append(printed, it)
		}
	}
	if len(printed) == 0 {
		return nil
	}
	items = printed

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

	// Маршрутизация та же, что у обычных бегунков: бесбумажные цехи «ОТМЕНУ»
	// тоже не печатают, цехи одного принтера — одним чеком.
	targets := s.routeRunnerItems(restaurantID, items, miByID)
	if len(targets) == 0 {
		return nil
	}

	// Стол / зона / официант — повар должен сразу видеть, чей заказ отменяется.
	meta := loadOrderPrintMeta(tx, order, false)
	cancelTableLabel := joinNonEmpty(", ", meta.TableLabel, meta.ZoneName)

	var rest models.Restaurant
	_ = tx.Where("id = ?", restaurantID).First(&rest).Error

	codepages := printerCodepages(tx, restaurantID)

	for _, t := range targets {
		in := escpos.CancelRunnerInput{
			Station:     runnerHeaderLabel(t.stations),
			Codepage:    codepageOfTarget(codepages, t.printerID),
			FastFood:    isFastFood(rest),
			OrderNumber: order.OrderNumber,
			TableLabel:  cancelTableLabel,
			WaiterName:  meta.WaiterName,
			CancelledAt: now,
			Reason:      reason,
		}
		for _, it := range t.items {
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
			PrinterID:    t.printerID,
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
	case "showcase":
		return "Витрина"
	default:
		return s
	}
}
