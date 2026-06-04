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
	Items          []ReceiptItem
	Subtotal       decimal.Decimal
	DiscountAmount decimal.Decimal
	ServiceAmount  decimal.Decimal
	TipAmount      decimal.Decimal
	Total          decimal.Decimal
	PaymentMethod  string
	Cols           int
	IsReprint      bool
	// Content suppress-flags (миграция 015).
	SuppressLogo     bool
	SuppressDiscount bool
	SuppressService  bool
	ShowTip          bool
	ShowQRFeedback   bool
	QRFeedbackURL    string
}

// ReceiptItem — одна позиция в чеке.
type ReceiptItem struct {
	Name      string
	Qty       decimal.Decimal
	Price     decimal.Decimal
	LineTotal decimal.Decimal
	Note      string
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

func buildReceipt(in ReceiptInput, isPreCheck bool) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	hrHeavy := strings.Repeat("=", cols)
	hrLight := strings.Repeat("-", cols)

	b := NewBuilder().Init().DisableKanji().CodePageCP866().CharsetRussia()

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
	dateStr := in.ClosedAt.Format("02.01.06 15:04")
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
	writeMeta("Чек №", orderRef)
	writeMeta("Дата", dateStr)
	writeMeta("", in.TableLabel)
	writeMeta("Официант", in.WaiterName)
	writeMeta("Кассир", in.CashierName)

	// ── Items header ──────────────────────────────────────────────────────
	b.TextLn(hrLight)
	b.TextLn(PadRow("Наименование", "Сумма", cols))
	b.TextLn(hrLight)

	// Items — name+qty + line total на одной строке. v1 ITEM_LEFT_MAX=30 для 42cols.
	itemLeftMax := cols - 12
	if itemLeftMax < 10 {
		itemLeftMax = 10
	}
	for _, it := range in.Items {
		qtyStr := fmtQtyDec(it.Qty)
		totalStr := fmtMoney(it.LineTotal) + " TJS"
		nameWithQty := it.Name + " " + qtyStr
		if visibleRuneCount(nameWithQty) > itemLeftMax {
			nameWithQty = runeSlice(nameWithQty, itemLeftMax)
		}
		b.TextLn(PadRow(nameWithQty, totalStr, cols))
		if it.Note != "" {
			b.TextLn("  ! " + it.Note)
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
}

// RunnerItem — позиция для повара.
type RunnerItem struct {
	Name      string
	Qty       int
	Modifiers []string
	Comment   string
}

// RunnerLayout — ранер на станцию. Порт buildEscPosRunner() из v1.
//
// КРИТИЧНО: используется FontTall (GS ! 01 = double-height, single-width)
// для items, а НЕ FontDouble (GS ! 11). Иначе на 80mm бумаге длинные
// названия блюд («Шашлык куриный») переносятся и обрезаются ножом до того
// как принтер допечатал содержимое.
func RunnerLayout(in RunnerInput) []byte {
	b := NewBuilder().Init().DisableKanji().CodePageCP866().CharsetRussia()

	// ── Station header — центр, bold, double-height ──────────────────────
	b.AlignCenter().Bold(true).FontTall()
	b.TextLn(strings.ToUpper(in.Station))
	b.FontNormal().Bold(false)

	// Разделитель 32 char (v1 hard-coded).
	b.TextLn("________________________________")

	// ── Order info — left align ──────────────────────────────────────────
	b.AlignLeft()
	timeStr := in.CreatedAt.Format("15:04")
	dateLine := timeStr + " Зак: " + strconv.Itoa(in.OrderNumber)
	if in.WaiterName != "" {
		dateLine += " " + in.WaiterName
	}
	b.TextLn(dateLine)

	// Стол + зона — bold
	if in.TableLabel != "" {
		b.Bold(true).TextLn(in.TableLabel).Bold(false)
	}
	b.TextLn("--------------------------------")

	// ── Items — bold + double-height (НЕ double-width!) ──────────────────
	b.FontTall().Bold(true)
	for _, it := range in.Items {
		qty := "x" + strconv.Itoa(it.Qty)
		name := it.Name
		// padding до ширины 20 (v1: pad = max(0, 20 - len(name) - len(qty)))
		nameLen := visibleRuneCount(name)
		qtyLen := visibleRuneCount(qty)
		pad := 20 - nameLen - qtyLen
		if pad < 1 {
			pad = 1
		}
		b.TextLn(name + spaces(pad) + qty)
		if len(it.Modifiers) > 0 {
			// Modifiers — normal size
			b.FontNormal()
			for _, m := range it.Modifiers {
				b.TextLn("  + " + m)
			}
			b.FontTall()
		}
		if it.Comment != "" {
			b.FontNormal()
			b.TextLn("  ! " + it.Comment)
			b.FontTall()
		}
	}
	b.Bold(false).FontNormal()

	// ── Comment ──────────────────────────────────────────────────────────
	if in.Comment != "" {
		b.TextLn("--------------------------------")
		b.TextLn("! " + in.Comment)
	}

	// ── Minimal feed + partial cut (v1: 0A then 1D 56 42 03) ─────────────
	b.LF()
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
}

// CancelRunnerLayout — отмена. Порт buildEscPosCancellation() из v1.
// БОЛЬШОЙ alert-блок (double-width + double-height + bold), чтобы повар
// гарантированно увидел отмену.
func CancelRunnerLayout(in CancelRunnerInput) []byte {
	b := NewBuilder().Init().DisableKanji().CodePageCP866().CharsetRussia()

	// ── Section 1: station header centered ──────────────────────────────
	b.AlignCenter()
	b.TextLn("(" + strings.ToUpper(in.Station) + ")")
	b.TextLn("================================")

	// ── Section 2: order info (left, table bold) ────────────────────────
	b.AlignLeft()
	timeStr := in.CancelledAt.Format("15:04")
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

	// ── Section 4: items (bold + double-height) ─────────────────────────
	b.FontTall().Bold(true)
	for _, it := range in.Items {
		qty := "x" + strconv.Itoa(it.Qty)
		name := "X " + it.Name
		nameLen := visibleRuneCount(name)
		qtyLen := visibleRuneCount(qty)
		pad := 20 - nameLen - qtyLen
		if pad < 1 {
			pad = 1
		}
		b.TextLn(name + spaces(pad) + qty)
	}
	b.Bold(false).FontNormal()
	b.TextLn("--------------------------------")

	b.LF()
	b.CutWithFeed(3)
	return b.Bytes()
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
	Cols           int
}

// XReportLayout — промежуточный отчёт.
func XReportLayout(in ReportInput) []byte { return reportLayout(in, "X-ОТЧЁТ", false) }

// ZReportLayout — финальный отчёт при закрытии смены.
func ZReportLayout(in ReportInput) []byte { return reportLayout(in, "Z-ОТЧЁТ", true) }

func reportLayout(in ReportInput, title string, withClosing bool) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	b := NewBuilder().Init().DisableKanji().CodePageCP866().CharsetRussia()
	b.Bold(true)

	b.AlignCenter().FontTall().TextLn(title).FontNormal()
	b.TextLn(in.RestaurantName)
	b.LF()

	b.AlignLeft()
	b.TextLnf("Смена:   %s", in.ShiftNumber)
	b.TextLnf("Открыта: %s", in.OpenedAt.Format("02.01.2006 15:04"))
	if withClosing && !in.ClosedAt.IsZero() {
		b.TextLnf("Закрыта: %s", in.ClosedAt.Format("02.01.2006 15:04"))
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
	total := decimal.Add(in.CashRevenue, in.CardRevenue)
	b.TextLn(PadRow("Выручка ИТОГО:", decToShort(total), cols))
	b.LF()

	if withClosing {
		b.TextLn(PadRow("Ожидается касса:", decToShort(in.ExpectedCash), cols))
		b.TextLn(PadRow("Фактически в кассе:", decToShort(in.ClosingBalance), cols))
		diff := decimal.Sub(in.ClosingBalance, in.ExpectedCash)
		b.TextLn(PadRow("Расхождение:", decToShort(diff), cols))
	}

	b.LF().AlignCenter().TextLnf("Отпечатан: %s", nowFn().Format("02.01.2006 15:04"))
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
