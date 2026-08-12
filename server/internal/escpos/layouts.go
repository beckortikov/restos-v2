// Layout-функции — порт `lib/print-service.ts` на Go.
//
// Каждая функция строит ESC/POS поток для конкретного типа документа:
//   - ReceiptLayout: гостевой счёт (final, после оплаты).
//   - PreBillLayout: предварительный счёт (до оплаты).
//   - RunnerLayout:  ранер на кухню (printer = station).
//   - CancelRunnerLayout: отмена позиции на кухню.
//   - XReportLayout / ZReportLayout: отчёты смены.
//
// Источник: ../restos/lib/print-service.ts функции buildEscPosRunner(),
// buildEscPosReceipt(), buildEscPosCancellation(). Это РАБОЧИЙ
// продакшен-формат v1 — копируем байт-в-байт, не «улучшаем».
//
// Ширина по умолчанию — 42 cols (бумага 80mm в v1). Для 58mm передавай Cols58.
// Runner — всегда 32 cols (как в v1, независимо от paper_width).
package escpos

import (
	"strconv"
	"strings"
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

const (
	// Receipt: 42 cols на 80mm бумаге (v1: RECEIPT_WIDTH=42).
	Cols80 = 42
	// 58mm бумага.
	Cols58 = 32
	// Runner: фиксированно 32 cols (v1 hard-coded — повару нужны крупные
	// строки, лишняя ширина не используется, разделитель из 32 дефисов).
	ColsRunner = 32
)

// nowFn — обёртка вокруг time.Now, подменяемая в тестах для детерминированных
// golden-выводов.
var nowFn = time.Now

// displayLoc — часовой пояс для печати дат/времени на чеках. Времена в БД
// хранятся в UTC; на чеке их нужно показывать в местном поясе кассы (сервер
// крутится на машине ресторана, её time.Local = пояс ресторана). В golden-тестах
// подменяется на UTC, чтобы вывод не зависел от TZ раннера.
var displayLoc = time.Local

// ReceiptInput — данные для печати чека клиенту.
type ReceiptInput struct {
	RestaurantName string
	RestaurantAddr string
	OrderNumber    int
	OpenedAt       time.Time
	ClosedAt       time.Time
	CashierName    string
	WaiterName     string
	TableLabel     string
	GuestsCount    int
	// Контакты доставки (052) — печатаются на ГОСТЕВОМ чеке для type='delivery':
	// чек уходит с едой, курьер берёт телефон и адрес отсюда. На кухонный
	// бегунок они НЕ идут — повару адрес клиента не нужен. Пусто для зала/с собой.
	DeliveryPhone   string
	DeliveryAddress string
	Items           []ReceiptItem
	Subtotal        decimal.Decimal
	DiscountAmount  decimal.Decimal
	ServiceAmount   decimal.Decimal
	TipAmount       decimal.Decimal
	Total           decimal.Decimal
	PaymentMethod   string
	Cols            int
	IsReprint       bool
	// FastFood — ресторан работает без столов (restaurants.tables_enabled=false):
	// гость забирает заказ по номеру. Включает крупный номер шапкой чека.
	FastFood bool
	// Content suppress-flags (миграция 015).
	SuppressLogo     bool
	SuppressDiscount bool
	SuppressService  bool
	ShowTip          bool
	ShowQRFeedback   bool
	QRFeedbackURL    string
	// Codepage — номер таблицы символов принтера (ESC t n). 0 → 17 (PC866).
	// Вынесен в настройку, потому что единой нумерации нет: часть принтеров
	// держит кириллицу на другом индексе и незнакомый номер игнорирует.
	Codepage byte
}

// ReceiptItem — одна позиция в чеке.
type ReceiptItem struct {
	Name      string
	Qty       decimal.Decimal
	Price     decimal.Decimal
	LineTotal decimal.Decimal
	Note      string
	// Unit — piece|g|kg. Для g/kg qty печатается как «100г»/«0,1кг» вместо «x…».
	Unit string
	// Count — кол-во одинаковых весовых порций, слитых в строку. >1 → «… × N».
	Count int
	// BundleGroupID — сет (миграция 073): компоненты одного добавления сета
	// в заказ печатаются подряд под заголовком «Сет:», а не как случайный
	// набор строк — гость должен видеть, что бургер и кола куплены вместе
	// одной ценой, хотя на кухню всё равно уходят отдельными позициями (см.
	// RunnerLayout — там группировки нет и не нужно, повар готовит по блюду).
	// Пусто — обычная позиция, поведение печати не меняется.
	BundleGroupID string
	// BundleSlotLabel — подпись слота этого компонента («Напиток», «Гарнир»),
	// печатается перед именем внутри группы «Сет:».
	BundleSlotLabel string
}

// ReceiptLayout строит байты гостевого счёта (после оплаты).
// Порт buildEscPosReceipt() из v1.
func ReceiptLayout(in ReceiptInput) []byte {
	return buildReceipt(in, false)
}

// PreBillLayout — предварительный счёт (до оплаты).
// Отличия от ReceiptLayout: заголовок «ПРЕДВАРИТЕЛЬНЫЙ СЧЁТ», нет блока
// «Оплата», футер «Не является фискальным документом».
func PreBillLayout(in ReceiptInput) []byte {
	return buildReceipt(in, true)
}

// receiptItemGroup — items, сгруппированные по BundleGroupID для печати.
// bundleGroupID == "" — обычная позиция (своя группа из одного элемента).
type receiptItemGroup struct {
	bundleGroupID string
	items         []ReceiptItem
}

// groupReceiptItemsByBundle группирует позиции чека по BundleGroupID —
// независимая Go-реализация того же принципа, что и groupByBundle на фронте
// (lib/helpers.ts): группа встаёт на позицию первого своего элемента, порядок
// сохраняется. По id, а не по соседству в срезе — компоненты сета в теории
// могут прийти не подряд, группировка по мапе от этого не ломается.
func groupReceiptItemsByBundle(items []ReceiptItem) []receiptItemGroup {
	groups := make([]receiptItemGroup, 0, len(items))
	byID := make(map[string]int, len(items))
	for _, it := range items {
		if it.BundleGroupID != "" {
			if i, ok := byID[it.BundleGroupID]; ok {
				groups[i].items = append(groups[i].items, it)
				continue
			}
			byID[it.BundleGroupID] = len(groups)
			groups = append(groups, receiptItemGroup{bundleGroupID: it.BundleGroupID, items: []ReceiptItem{it}})
			continue
		}
		groups = append(groups, receiptItemGroup{items: []ReceiptItem{it}})
	}
	return groups
}

func buildReceipt(in ReceiptInput, isPreCheck bool) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	hrHeavy := strings.Repeat("=", cols)
	hrLight := strings.Repeat("-", cols)

	b := beginPayload(in.Codepage)

	// v1: bold ON для всего чека — на термопринтерах non-bold печатает блекло.
	b.Bold(true)

	// ── Header ────────────────────────────────────────────────────────────
	b.AlignCenter()
	if !in.SuppressLogo {
		b.TextLn(hrHeavy)
		// Restaurant name — double height (GS ! 01, не 11 — единичная ширина).
		b.FontTall()
		b.TextLn(strings.ToUpper(stripEmoji(in.RestaurantName)))
		b.FontNormal()
		if in.RestaurantAddr != "" {
			b.TextLn(in.RestaurantAddr)
		}
		b.TextLn(hrHeavy)
	}

	// ── Фастфуд: крупный номер заказа шапкой ─────────────────────────────
	// Гость забирает заказ по номеру, поэтому число идёт ПЕРВЫМ и самым
	// крупным кеглем (6×) — читается через зал. В зале с официантами номер
	// гостю не нужен, поэтому только при FastFood.
	if in.FastFood {
		b.TextLn("ВАШ НОМЕР")
		b.FontBig()
		b.TextLn(strconv.Itoa(in.OrderNumber))
		b.FontNormal()
		b.TextLn(hrHeavy)
	}

	// ── Document title — double size (tall, single width) ────────────────
	b.FontTall()
	if isPreCheck {
		b.TextLn("ПРЕДВАРИТЕЛЬНЫЙ СЧЁТ")
	} else if in.IsReprint {
		b.TextLn("КОПИЯ ЧЕКА")
	} else {
		b.TextLn("ГОСТЕВОЙ СЧЁТ")
	}
	b.FontNormal()

	// ── Meta block (centered, dashed divider) ────────────────────────────
	b.TextLn(hrLight)

	// Чек № / Дата / Стол / Официант / Кассир / Гостей
	dateStr := in.ClosedAt.In(displayLoc).Format("02.01.06 15:04")
	orderRef := "#" + strconv.Itoa(in.OrderNumber)

	writeMeta := func(k, v string) {
		if v == "" {
			return
		}
		if k == "" {
			b.TextLn(v)
		} else {
			b.TextLn(PadRow(k, v, cols))
		}
	}
	if !in.FastFood {
		// В фастфуде номер уже напечатан крупно шапкой — не дублируем.
		writeMeta("Чек №", orderRef)
	}
	writeMeta("Дата", dateStr)
	writeMeta("", in.TableLabel)
	// В фастфуде официантов нет — заказ принимает кассир за стойкой. Строка
	// «Официант» на гостевом чеке дублировала бы «Кассир» тем же именем.
	// Кухонный бегунок ниже прячет её по тому же признаку.
	if !in.FastFood {
		writeMeta("Официант", in.WaiterName)
	}
	writeMeta("Кассир", in.CashierName)
	if in.GuestsCount > 0 {
		writeMeta("Гостей", strconv.Itoa(in.GuestsCount))
	}
	// Контакты доставки — на гостевом чеке (курьер забирает еду вместе с чеком).
	// Телефон строкой meta, адрес — отдельной строкой на всю ширину (переносит
	// сам принтер). Раньше этот блок печатался на кухонном бегунке — убрали.
	if in.DeliveryPhone != "" {
		writeMeta("Тел", in.DeliveryPhone)
	}
	if in.DeliveryAddress != "" {
		writeMeta("", "Адрес: "+in.DeliveryAddress)
	}

	// ── Items header ──────────────────────────────────────────────────────
	b.TextLn(hrLight)
	b.TextLn(PadRow("Наименование", "Сумма", cols))
	b.TextLn(hrLight)

	// Items — name+qty + line total на одной строке. v1 ITEM_LEFT_MAX=30 для 42cols.
	itemLeftMax := cols - 12
	if itemLeftMax < 10 {
		itemLeftMax = 10
	}
	for _, grp := range groupReceiptItemsByBundle(in.Items) {
		// Сет: заголовок перед своими компонентами + подпись слота у каждого
		// («Напиток», «Гарнир») — гость видит, что позиции куплены вместе
		// одной ценой сета, а не как случайный набор строк.
		if grp.bundleGroupID != "" {
			b.TextLn("Сет:")
		}
		for _, it := range grp.items {
			// Вес печатаем как «100г»/«0,1кг»; штучные — как «x3».
			qtyStr := fmtQtyDec(it.Qty)
			if it.Unit == "g" || it.Unit == "kg" {
				qtyStr = fmtWeightQty(it.Qty, it.Unit)
			}
			totalStr := fmtMoney(it.LineTotal) + " TJS"
			name := it.Name
			if grp.bundleGroupID != "" && it.BundleSlotLabel != "" {
				name = it.BundleSlotLabel + ": " + name
			}
			nameWithQty := name + " " + qtyStr
			// Слитые одинаковые весовые порции: «Блюдо 100г × 3».
			if it.Count > 1 {
				nameWithQty += " × " + strconv.Itoa(it.Count)
			}
			if visibleRuneCount(nameWithQty) > itemLeftMax {
				nameWithQty = runeSlice(nameWithQty, itemLeftMax)
			}
			b.TextLn(PadRow(nameWithQty, totalStr, cols))
			if it.Note != "" {
				b.TextLn("  ! " + it.Note)
			}
		}
	}
	b.TextLn(hrLight)

	// ── Totals: Подытог → Обслуживание → Скидка → Чаевые ─────────────────
	b.TextLn(PadRow("Подытог", fmtMoney(in.Subtotal)+" TJS", cols))
	if !in.ServiceAmount.IsZero() && !in.SuppressService {
		b.TextLn(PadRow("Обслуживание", fmtMoney(in.ServiceAmount)+" TJS", cols))
	}
	if !in.DiscountAmount.IsZero() && !in.SuppressDiscount {
		b.TextLn(PadRow("Скидка", "-"+fmtMoney(in.DiscountAmount)+" TJS", cols))
	}
	if !in.TipAmount.IsZero() && in.ShowTip {
		b.TextLn(PadRow("Чаевые", fmtMoney(in.TipAmount)+" TJS", cols))
	}

	// ── ИТОГО — double width+height (GS ! 11) ─────────────────────────────
	b.TextLn(hrHeavy)
	b.FontDouble()
	// double-width => budget halves.
	b.TextLn(PadRow("ИТОГО", fmtMoney(in.Total)+" TJS", cols/2))
	b.FontNormal()
	b.TextLn(hrHeavy)

	// ── Payment (пропускаем для pre-check) ────────────────────────────────
	if !isPreCheck && in.PaymentMethod != "" {
		b.TextLn(PadRow("Оплата", paymentLabel(in.PaymentMethod), cols))
	}

	// ── Footer ────────────────────────────────────────────────────────────
	b.LF()
	if isPreCheck {
		b.TextLn("Не является фискальным документом")
	} else {
		b.TextLn("СПАСИБО! ЖДЁМ ВАС СНОВА!")
	}
	b.TextLn("Powered by RestOS")
	b.LF()

	// QR-фидбэк (v4-only расширение, после футера).
	if in.ShowQRFeedback && in.QRFeedbackURL != "" {
		b.TextLn("Оцените заведение:")
		b.QRCode(in.QRFeedbackURL, 5)
		b.LF()
	}

	// Bold off + partial cut с подмоткой 3 строки (v1: 1D 56 42 03).
	b.Bold(false)
	b.CutWithFeed(3)
	return b.Bytes()
}

// RunnerInput — данные для печати ранера на кухню.
type RunnerInput struct {
	Station     string
	OrderNumber int
	TableLabel  string
	WaiterName  string
	CreatedAt   time.Time
	Items       []RunnerItem
	Comment     string
	Cols        int // игнорируется, runner всегда 32 cols
	// FastFood — крупный номер заказа вместо станции шапкой (см. ReceiptInput).
	FastFood bool
	// OrderType — «Зал» / «С собой» / «Доставка». В фастфуде печатается в шапке
	// (время · ТИП) вместо станции: на одной кухне повару полезнее знать способ
	// выдачи, чем цех. Пусто → печатается только время.
	OrderType string
	// Codepage — номер таблицы символов принтера (ESC t n). 0 → 17 (PC866).
	// Вынесен в настройку, потому что единой нумерации нет: часть принтеров
	// держит кириллицу на другом индексе и незнакомый номер игнорирует.
	Codepage byte
}

// RunnerItem — позиция для повара.
//
// Qty — целое число порций для «piece» блюд. Для весовых (Unit="g"/"kg")
// игнорируется, печатается QtyDec с единицей измерения вместо «x1».
type RunnerItem struct {
	Name      string
	Qty       int
	QtyDec    decimal.Decimal // фактическое qty с дробной частью (для весовых)
	Unit      string          // "piece"|"g"|"kg" — если пусто/piece → x{Qty}
	Modifiers []string
	Comment   string
	// Count — кол-во одинаковых весовых порций, слитых в строку (>1 → «… × N»).
	Count int
}

// fmtWeightQty — «250г» / «1,5кг» для весовых порций.
func fmtWeightQty(q decimal.Decimal, unit string) string {
	switch unit {
	case "g":
		g := q.Round(0).IntPart()
		return strconv.FormatInt(g, 10) + "г"
	case "kg":
		places := int32(1)
		if q.LessThan(decimal.FromInt(10)) {
			places = 2
		}
		s := q.Round(places).String()
		s = strings.Replace(s, ".", ",", 1)
		if strings.Contains(s, ",") {
			s = strings.TrimRight(s, "0")
			s = strings.TrimRight(s, ",")
		}
		return s + "кг"
	default:
		return q.String()
	}
}

// fmtRunnerQty — «x2» для штучных, «250г» / «1,5кг» для весовых.
// Порт логики из v1 lib/print-service.ts:155-160.
// runnerItemLine — строка позиции: имя слева, количество прижато вправо.
func runnerItemLine(name, qty string, cols int) string {
	pad := cols - visibleRuneCount(name) - visibleRuneCount(qty)
	if pad < 1 {
		pad = 1
	}
	return name + spaces(pad) + qty
}

func fmtRunnerQty(it RunnerItem) string {
	switch it.Unit {
	case "g", "kg":
		s := fmtWeightQty(it.QtyDec, it.Unit)
		// Слитые одинаковые порции: «100г × 3».
		if it.Count > 1 {
			s += " × " + strconv.Itoa(it.Count)
		}
		return s
	default:
		if it.Count > 1 {
			return "x" + strconv.Itoa(it.Qty*it.Count)
		}
		return "x" + strconv.Itoa(it.Qty)
	}
}

// fmtRunnerQtyLead — количество как ВЕДУЩИЙ токен (фастфуд, количество впереди):
// «2×» для штучных, вес — как есть («250г», «1,5кг × 3»). Отличается от
// fmtRunnerQty порядком: там число прижато вправо строкой «x2».
func fmtRunnerQtyLead(it RunnerItem) string {
	switch it.Unit {
	case "g", "kg":
		return fmtRunnerQty(it)
	default:
		n := it.Qty
		if it.Count > 1 {
			n = it.Qty * it.Count
		}
		return strconv.Itoa(n) + "×"
	}
}

// RunnerLayout — ранер на станцию. Порт buildEscPosRunner() из v1.
//
// Позиции печатаются БЕЗ растяжения по осям (1×1). Прежний FontTall
// (1× ширина × 2× высота) давал узкие вытянутые буквы: заголовок цеха,
// набранный вдвое мельче, но естественными пропорциями, читался лучше самих
// названий блюд. FontDouble (2×2) не берём — в 16 колонок не влезает почти
// ни одно реальное название, и каждое пришлось бы переносить.
func RunnerLayout(in RunnerInput) []byte {
	b := beginPayload(in.Codepage)

	timeStr := in.CreatedAt.In(displayLoc).Format("15:04")

	// ── Шапка ────────────────────────────────────────────────────────────
	// Фастфуд: номер заказа ВМЕСТО станции — повару он нужен, чтобы собрать
	// заказ и выкрикнуть его, поэтому число идёт первым и крупнее названий
	// блюд (6×). Станция уходит подписью. В зале с официантами наоборот:
	// станция важнее (несколько цехов), номер — служебная строка.
	if in.FastFood {
		b.AlignCenter().Bold(true)
		b.FontBig()
		b.TextLn(strconv.Itoa(in.OrderNumber))
		b.FontNormal()
		// Подпись под номером: время и ТИП заказа (Зал/С собой/Доставка).
		// Станцию не печатаем — на фастфуде кухня одна, а тип важнее для выдачи.
		sub := timeStr
		if in.OrderType != "" {
			sub = timeStr + " · " + strings.ToUpper(in.OrderType)
		}
		b.TextLn(sub)
		b.Bold(false)
	} else {
		// 2×2, а не 1×2: заголовку тоже не нужны вытянутые буквы. Имя цеха
		// короткое и в 16 колонок влезает, так что растягивать нечего.
		b.AlignCenter().Bold(true).FontDouble()
		b.TextLn(strings.ToUpper(in.Station))
		b.FontNormal().Bold(false)
	}

	// Разделитель 32 char (v1 hard-coded).
	b.TextLn("________________________________")

	// ── Order info — left align ──────────────────────────────────────────
	b.AlignLeft()
	// В фастфуде шапка самодостаточна (номер + время + тип). Официант, кассир и
	// число гостей повару не нужны — печать этих полей убрана из кухонного чека.
	// В зале — служебная строка: время, номер заказа, официант, стол+зона.
	if !in.FastFood {
		dateLine := timeStr + " Зак: " + strconv.Itoa(in.OrderNumber)
		if in.WaiterName != "" {
			dateLine += " " + in.WaiterName
		}
		b.TextLn(dateLine)
		if in.TableLabel != "" {
			b.Bold(true).TextLn(in.TableLabel).Bold(false)
		}
	}

	// Контакты доставки (телефон/адрес) на кухонный бегунок НЕ печатаем — повару
	// данные клиента не нужны, они уходят на гостевой чек (курьер забирает еду
	// с чеком). См. ReceiptInput.DeliveryPhone/DeliveryAddress.
	//
	// Разделитель перед позициями: в зале — всегда; в фастфуде не нужен — шапку
	// уже отделило подчёркивание, второй разделитель подряд = пустой шум сверху.
	if !in.FastFood {
		b.TextLn("--------------------------------")
	}

	// ── Items ────────────────────────────────────────────────────────────
	// Зал (несколько цехов): имя слева, количество справа, растянутая высота
	// (GS ! 0x01 — двойная высота, ОДИНАРНАЯ ширина, все 32 колонки ленты).
	// Двойную ширину (2×2, как в фастфуде) сознательно не берём: в 16 колонок
	// не влезает почти ни одно реальное название зального меню, пришлось бы
	// переносить (пробовали и откатили в v3.16.121→122). FontTall даёт узкие
	// вытянутые буквы — на фастфуде это признали нечитаемым и в v3.16.150
	// заменили на 2×2, но там жалоба была именно про фастфуд-бегунок: на
	// зальном 0x01 читался нормально, поэтому возвращаем его сюда явно.
	//
	// Фастфуд: имя блюда КРУПНО (2×2 — двойная ширина И высота) и жирным, как
	// кухонный чек iiko: повар читает его через зал. Количество — ведущим
	// токеном («2×»). Длинное имя (16 колонок в 2×) переносит сам принтер —
	// это осознанно: крупно и читаемо важнее, чем «в одну строку». Между
	// блюдами — пустая строка, чтобы список сканировался быстрее.
	for i, it := range in.Items {
		if in.FastFood {
			if i > 0 {
				b.LF()
			}
			b.FontDouble().Bold(true)
			b.TextLn(fmtRunnerQtyLead(it) + " " + strings.ToUpper(it.Name))
			b.FontNormal().Bold(false)
		} else {
			// Шрифт — на КАЖДОЙ позиции, а не один раз до цикла: иначе после
			// модификаторов предыдущего блюда (они сбрасывают в FontNormal)
			// имя следующего блюда молча печаталось бы мелким.
			b.FontTall().Bold(true)
			b.TextLn(runnerItemLine(it.Name, fmtRunnerQty(it), ColsRunner))
			b.FontNormal().Bold(false)
		}
		if len(it.Modifiers) > 0 {
			// Modifiers — normal size
			b.FontNormal()
			for _, m := range it.Modifiers {
				b.TextLn("  + " + m)
			}
		}
		if it.Comment != "" {
			b.FontNormal()
			b.TextLn("  ! " + it.Comment)
		}
	}

	// ── Comment ──────────────────────────────────────────────────────────
	if in.Comment != "" {
		b.TextLn("--------------------------------")
		b.TextLn("! " + in.Comment)
	}

	// ── Minimal feed + partial cut (v1: 0A then 1D 56 42 03) ─────────────
	b.LF()
	// v2.1.6: Beep ДО Cut — иначе на некоторых принтерах команда после
	// GS V буферизуется для следующего задания, либо парсер останавливается
	// (симптом: «принтер не печатает»). Сначала пикаем, потом режем.
	b.Beep(1, 3)
	b.CutWithFeed(3)
	return b.Bytes()
}

// CancelRunnerInput — отмена позиций на кухне.
type CancelRunnerInput struct {
	Station     string
	OrderNumber int
	TableLabel  string
	WaiterName  string
	CancelledAt time.Time
	Items       []RunnerItem
	Reason      string
	Cols        int
	// FastFood — крупный номер заказа шапкой, как в обычном бегунке.
	// Без него отмена приходила с мелким «Зак: 1», и повар не мог сопоставить
	// её со стопкой чеков, где номера напечатаны 6× — а сопоставить надо
	// быстро, блюдо уже в работе.
	FastFood bool
	// Codepage — номер таблицы символов принтера (ESC t n). 0 → 17 (PC866).
	// Вынесен в настройку, потому что единой нумерации нет: часть принтеров
	// держит кириллицу на другом индексе и незнакомый номер игнорирует.
	Codepage byte
}

// CancelRunnerLayout — отмена. Порт buildEscPosCancellation() из v1.
// БОЛЬШОЙ alert-блок (double-width + double-height + bold), чтобы повар
// гарантированно увидел отмену.
func CancelRunnerLayout(in CancelRunnerInput) []byte {
	b := beginPayload(in.Codepage)

	// ── Section 1: station header centered ──────────────────────────────
	// Фастфуд: номер заказа первым и крупно — тем же кеглем, что в обычном
	// бегунке, иначе отмену не сопоставить со стопкой чеков на полке.
	b.AlignCenter()
	if in.FastFood {
		b.Bold(true).FontBig()
		b.TextLn(strconv.Itoa(in.OrderNumber))
		b.FontNormal().Bold(false)
	}
	b.TextLn("(" + strings.ToUpper(in.Station) + ")")
	b.TextLn("================================")

	// ── Section 2: order info (left, table bold) ────────────────────────
	b.AlignLeft()
	timeStr := in.CancelledAt.In(displayLoc).Format("15:04")
	dateLine := timeStr + " Зак: " + strconv.Itoa(in.OrderNumber)
	if in.WaiterName != "" {
		dateLine += " " + in.WaiterName
	}
	b.TextLn(dateLine)
	if in.TableLabel != "" {
		b.Bold(true).TextLn(in.TableLabel).Bold(false)
	}

	// ── Section 3: BIG ALERT (centered, bold, double w+h) ───────────────
	b.LF()
	b.AlignCenter().Bold(true).FontDouble()
	b.TextLn("*** ОТМЕНА ***")
	b.TextLn("ВНИМАНИЕ !")
	b.TextLn("БЛЮДА УДАЛЕНЫ!")
	b.TextLn("НЕ ГОТОВИТЬ!")
	b.TextLn("*** ОТМЕНА ***")
	b.FontNormal().Bold(false).AlignLeft()
	b.TextLn("--------------------------------")

	// ── Section 4: items ────────────────────────────────────────────────
	// Зал — тот же кегль, что в обычном бегунке (FontTall, см. RunnerLayout):
	// повар сверяет отмену с бегунком, строки должны выглядеть одинаково,
	// иначе сопоставлять их труднее. Фастфуд здесь не трогаем — формат его
	// отмены не менялся.
	if !in.FastFood {
		b.FontTall().Bold(true)
	} else {
		b.FontNormal().Bold(true)
	}
	for _, it := range in.Items {
		qty := fmtRunnerQty(it)
		b.TextLn(runnerItemLine("X "+it.Name, qty, ColsRunner))
	}
	b.Bold(false).FontNormal()
	b.TextLn("--------------------------------")

	b.LF()
	// v2.1.6: Beep ДО Cut (см. RunnerLayout) — пик ставим в hot path
	// payload'а до cut-команды, иначе на некоторых принтерах теряется.
	b.Beep(3, 4)
	b.CutWithFeed(3)
	return b.Bytes()
}

// ReportExpenseLine — строка расхода по категории для X/Z-отчёта.
type ReportExpenseLine struct {
	Category string
	Amount   decimal.Decimal
}

// ReportBankLine — безнал. выручка в разрезе конкретного счёта (банка/терминала).
type ReportBankLine struct {
	Name   string
	Amount decimal.Decimal
}

// ReportInput — общие поля для X/Z-отчёта.
type ReportInput struct {
	RestaurantName string
	ShiftNumber    string
	OpenedAt       time.Time
	ClosedAt       time.Time
	OpeningBalance decimal.Decimal
	CashRevenue    decimal.Decimal
	CardRevenue    decimal.Decimal
	OrdersCount    int
	AvgCheck       decimal.Decimal
	ExpectedCash   decimal.Decimal
	ClosingBalance decimal.Decimal
	CashierName    string
	// Движение денег по кассе (HoReCa-стандарт). Внесения/изъятия/расходы.
	CashIn      decimal.Decimal
	Withdrawals decimal.Decimal
	Expenses    []ReportExpenseLine
	// Безнал в разрезе счетов (Банк А / Банк Б). Сумма строк = CardRevenue.
	CardByBank []ReportBankLine
	Cols       int
	// Codepage — таблица символов принтера (ESC t n). 0 → 17 (PC866).
	Codepage byte
}

// XReportLayout — промежуточный отчёт.
func XReportLayout(in ReportInput) []byte { return reportLayout(in, "X-ОТЧЁТ", false) }

// ZReportLayout — финальный отчёт при закрытии смены.
func ZReportLayout(in ReportInput) []byte { return reportLayout(in, "Z-ОТЧЁТ", true) }

// ServiceWaiterLine — строка обслуживания по официанту.
type ServiceWaiterLine struct {
	Name    string
	Accrued decimal.Decimal // начислено (service_amount)
	Paid    decimal.Decimal // выплачено
	ToPay   decimal.Decimal // к выплате (max(0, accrued − paid))
}

// ServiceReportInput — данные чека «Обслуживание официантов» за смену.
type ServiceReportInput struct {
	RestaurantName string
	ShiftNumber    string
	OpenedAt       time.Time
	ClosedAt       time.Time
	Waiters        []ServiceWaiterLine
	Cols           int
	// Codepage — таблица символов принтера (ESC t n). 0 → 17 (PC866).
	Codepage byte
}

// ServiceReportLayout — чек по сервисному сбору за смену (рядом с X/Z).
func ServiceReportLayout(in ServiceReportInput) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	b := beginPayload(in.Codepage)
	b.Bold(true)
	b.AlignCenter().FontTall().TextLn("ОБСЛУЖИВАНИЕ").FontNormal()
	b.TextLn(in.RestaurantName)
	b.LF()

	b.AlignLeft()
	b.TextLnf("Смена:   %s", in.ShiftNumber)
	b.TextLnf("Открыта: %s", in.OpenedAt.In(displayLoc).Format("02.01.2006 15:04"))
	if !in.ClosedAt.IsZero() {
		b.TextLnf("Закрыта: %s", in.ClosedAt.In(displayLoc).Format("02.01.2006 15:04"))
	}
	b.TextLn(strings.Repeat("-", cols))

	totalAccrued, totalPaid, totalToPay := decimal.Zero, decimal.Zero, decimal.Zero
	if len(in.Waiters) == 0 {
		b.AlignCenter().TextLn("Нет начислений").AlignLeft()
	}
	for _, w := range in.Waiters {
		b.Bold(true).TextLn(stripEmoji(w.Name)).Bold(false)
		b.TextLn(PadRow("  Начислено:", decToShort(w.Accrued), cols))
		b.TextLn(PadRow("  Выплачено:", decToShort(w.Paid), cols))
		b.TextLn(PadRow("  К выплате:", decToShort(w.ToPay), cols))
		totalAccrued = decimal.Add(totalAccrued, w.Accrued)
		totalPaid = decimal.Add(totalPaid, w.Paid)
		totalToPay = decimal.Add(totalToPay, w.ToPay)
	}

	b.TextLn(strings.Repeat("-", cols))
	b.TextLn(PadRow("Начислено ИТОГО:", decToShort(totalAccrued), cols))
	b.TextLn(PadRow("Выплачено ИТОГО:", decToShort(totalPaid), cols))
	b.Bold(true).TextLn(PadRow("К ВЫПЛАТЕ ИТОГО:", decToShort(totalToPay), cols)).Bold(false)

	b.LF().AlignCenter().TextLnf("Отпечатан: %s", nowFn().In(displayLoc).Format("02.01.2006 15:04"))
	b.Bold(false).CutWithFeed(3)
	return b.Bytes()
}

func reportLayout(in ReportInput, title string, withClosing bool) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	b := beginPayload(in.Codepage)
	b.Bold(true)

	b.AlignCenter().FontTall().TextLn(title).FontNormal()
	b.TextLn(in.RestaurantName)
	b.LF()

	b.AlignLeft()
	b.TextLnf("Смена:   %s", in.ShiftNumber)
	b.TextLnf("Открыта: %s", in.OpenedAt.In(displayLoc).Format("02.01.2006 15:04"))
	if withClosing && !in.ClosedAt.IsZero() {
		b.TextLnf("Закрыта: %s", in.ClosedAt.In(displayLoc).Format("02.01.2006 15:04"))
	}
	if in.CashierName != "" {
		b.TextLnf("Кассир:  %s", in.CashierName)
	}
	b.TextLn(strings.Repeat("-", cols))

	b.TextLn(PadRow("Остаток на начало:", decToShort(in.OpeningBalance), cols))
	b.TextLn(PadRow("Кол-во чеков:", strconv.Itoa(in.OrdersCount), cols))
	b.TextLn(PadRow("Средний чек:", decToShort(in.AvgCheck), cols))
	b.LF()
	b.TextLn(PadRow("Наличная выручка:", decToShort(in.CashRevenue), cols))
	b.TextLn(PadRow("Безнал. выручка:", decToShort(in.CardRevenue), cols))
	for _, bank := range in.CardByBank {
		b.TextLn(PadRow("  "+stripEmoji(bank.Name), decToShort(bank.Amount), cols))
	}
	total := decimal.Add(in.CashRevenue, in.CardRevenue)
	b.TextLn(PadRow("Выручка ИТОГО:", decToShort(total), cols))
	b.LF()

	// ── Движение денег по кассе (HoReCa) ──────────────────────────────────
	// Остаток + нал.выручка + внесения − изъятия − расходы = ожидается касса.
	expensesTotal := decimal.Zero
	for _, e := range in.Expenses {
		expensesTotal = decimal.Add(expensesTotal, e.Amount)
	}
	hasMovement := !in.CashIn.IsZero() || !in.Withdrawals.IsZero() || !expensesTotal.IsZero()
	if hasMovement {
		b.TextLn("ДВИЖЕНИЕ ПО КАССЕ")
		if !in.CashIn.IsZero() {
			b.TextLn(PadRow("Внесения:", "+"+decToShort(in.CashIn), cols))
		}
		if !in.Withdrawals.IsZero() {
			b.TextLn(PadRow("Изъятия:", "-"+decToShort(in.Withdrawals), cols))
		}
		if !expensesTotal.IsZero() {
			b.TextLn(PadRow("Расходы:", "-"+decToShort(expensesTotal), cols))
			for _, e := range in.Expenses {
				b.TextLn(PadRow("  "+stripEmoji(e.Category), decToShort(e.Amount), cols))
			}
		}
		b.LF()
	}

	if withClosing {
		b.TextLn(PadRow("Ожидается касса:", decToShort(in.ExpectedCash), cols))
		b.TextLn(PadRow("Фактически в кассе:", decToShort(in.ClosingBalance), cols))
		diff := decimal.Sub(in.ClosingBalance, in.ExpectedCash)
		b.TextLn(PadRow("Расхождение:", decToShort(diff), cols))
	}

	b.LF().AlignCenter().TextLnf("Отпечатан: %s", nowFn().In(displayLoc).Format("02.01.2006 15:04"))
	b.Bold(false).CutWithFeed(3)
	return b.Bytes()
}

// ─── helpers ──────────────────────────────────────────────────────────────

// fmtMoney — "1234,50" (запятая как разделитель, v1 совместимо).
func fmtMoney(d decimal.Decimal) string {
	s := d.RoundBank(2).String()
	// Decimal.String() даёт точку — заменим на запятую.
	return strings.Replace(s, ".", ",", 1)
}

// fmtQtyDec — qty форматирование (целое число → "x2", дробное → "0,5").
func fmtQtyDec(q decimal.Decimal) string {
	f, _ := q.Float64()
	if f == float64(int64(f)) {
		return "x" + strconv.FormatInt(int64(f), 10)
	}
	return "x" + strings.Replace(q.RoundBank(2).String(), ".", ",", 1)
}

// decToShort — Decimal → "1234.50" (для отчётов, без замены точки).
func decToShort(d decimal.Decimal) string {
	return d.RoundBank(2).String()
}

// stripEmoji удаляет emoji/символы вне CP866 — иначе печатается «?».
func stripEmoji(s string) string {
	var b strings.Builder
	for _, r := range s {
		// Базовый ASCII + кириллица + типография CP866.
		if r < 0x80 || (r >= 0x0400 && r <= 0x04FF) || r == '·' || r == '№' || r == '°' {
			b.WriteRune(r)
		}
	}
	return strings.TrimSpace(b.String())
}

// dashes — строка из n дефисов.
func dashes(n int) string {
	if n <= 0 {
		return ""
	}
	return strings.Repeat("-", n)
}

// runeSlice — обрезка строки по числу рун (не байт).
func runeSlice(s string, n int) string {
	rs := []rune(s)
	if len(rs) <= n {
		return s
	}
	return string(rs[:n])
}

// paymentLabel — человеческая надпись по типу оплаты.
// v1: 'cash' → 'Наличные', card/transfer → 'Безналичные'.
func paymentLabel(method string) string {
	switch method {
	case "cash":
		return "Наличные"
	case "card", "transfer":
		return "Безналичные"
	default:
		return method
	}
}
