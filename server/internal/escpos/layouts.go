// Layout-функции — порт `lib/print-service.ts` на Go.
//
// Каждая функция строит ESC/POS поток для конкретного типа документа:
//   - ReceiptLayout: фискальный чек клиенту (printer = receipt).
//   - RunnerLayout:  ранер на кухню (printer = station).
//   - CancelRunnerLayout: отмена позиции на кухню.
//   - XReportLayout: промежуточный отчёт смены (без обнуления).
//   - ZReportLayout: финальный отчёт смены при закрытии.
//
// Источник: ../restos/lib/print-service.ts функции buildReceipt(), buildRunner(),
// buildCancelRunner(), buildXReport(), buildZReport().
//
// Ширина по умолчанию — 48 cols (бумага 80mm). Для 58mm передавай ColsNarrow.
package escpos

import (
	"strconv"
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

const (
	Cols80 = 48 // ширина в моноширных символах для 80mm
	Cols58 = 32 // для 58mm
)

// nowFn — обёртка вокруг time.Now, подменяемая в тестах для детерминированных
// golden-выводов (см. golden_test.go withFixedNow).
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
	TableLabel     string // "Стол 5" или "С собой"
	Items          []ReceiptItem
	Subtotal       decimal.Decimal
	DiscountAmount decimal.Decimal
	ServiceAmount  decimal.Decimal
	TipAmount      decimal.Decimal
	Total          decimal.Decimal
	PaymentMethod  string
	Cols           int // 48 или 32
}

// ReceiptItem — одна позиция в чеке.
type ReceiptItem struct {
	Name      string
	Qty       decimal.Decimal
	Price     decimal.Decimal
	LineTotal decimal.Decimal
}

// ReceiptLayout строит байты чека клиенту.
func ReceiptLayout(in ReceiptInput) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	b := NewBuilder().Init().CodePageCP866().CharsetRussia()

	// Header.
	b.AlignCenter().FontDouble().TextLn(in.RestaurantName).FontNormal()
	if in.RestaurantAddr != "" {
		b.TextLn(in.RestaurantAddr)
	}
	b.LF()

	// Meta.
	b.AlignLeft().Bold(true).TextLnf("Чек № %d", in.OrderNumber).Bold(false)
	b.TextLnf("Открыт:  %s", in.OpenedAt.Format("02.01.2006 15:04"))
	b.TextLnf("Закрыт:  %s", in.ClosedAt.Format("02.01.2006 15:04"))
	if in.TableLabel != "" {
		b.TextLn(in.TableLabel)
	}
	if in.WaiterName != "" {
		b.TextLnf("Официант: %s", in.WaiterName)
	}
	if in.CashierName != "" {
		b.TextLnf("Кассир:   %s", in.CashierName)
	}

	b.Text(dashes(cols)).LF()

	// Items.
	for _, it := range in.Items {
		// Строка 1: "Название" — длинная, может переноситься.
		b.TextLn(it.Name)
		// Строка 2: "qty x price        line_total"
		left := strconv.Itoa(qtyAsInt(it.Qty)) + " x " + decToShort(it.Price)
		right := decToShort(it.LineTotal)
		b.TextLn(PadRow("  "+left, right, cols))
	}
	b.Text(dashes(cols)).LF()

	// Totals.
	b.TextLn(PadRow("Сумма:", decToShort(in.Subtotal), cols))
	if !in.DiscountAmount.IsZero() {
		b.TextLn(PadRow("Скидка:", "-"+decToShort(in.DiscountAmount), cols))
	}
	if !in.ServiceAmount.IsZero() {
		b.TextLn(PadRow("Сервис:", decToShort(in.ServiceAmount), cols))
	}
	if !in.TipAmount.IsZero() {
		b.TextLn(PadRow("Чаевые:", decToShort(in.TipAmount), cols))
	}
	b.Bold(true).FontDouble()
	b.TextLn(PadRow("ИТОГО:", decToShort(in.Total), cols/2))
	b.FontNormal().Bold(false)

	if in.PaymentMethod != "" {
		b.TextLnf("Оплата: %s", paymentLabel(in.PaymentMethod))
	}

	b.LF().AlignCenter().TextLn("Спасибо за визит!").LF()

	// Cut с подмоткой 3 строки.
	b.Feed(3).CutFull()
	return b.Bytes()
}

// RunnerInput — данные для печати ранера на кухню.
type RunnerInput struct {
	Station     string // "Горячий цех", "Бар"
	OrderNumber int
	TableLabel  string
	WaiterName  string
	CreatedAt   time.Time
	Items       []RunnerItem
	Comment     string
	Cols        int
}

// RunnerItem — позиция для повара.
type RunnerItem struct {
	Name      string
	Qty       int
	Modifiers []string
	Comment   string
}

// RunnerLayout — ранер на станцию (повар видит, что готовить).
// Без цен, крупные позиции, акцент на стол + время.
func RunnerLayout(in RunnerInput) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	b := NewBuilder().Init().CodePageCP866().CharsetRussia()

	b.AlignCenter().FontDouble().Bold(true).TextLn(in.Station).Bold(false).FontNormal()
	b.LF()
	b.AlignLeft().FontDouble().TextLnf("Заказ № %d", in.OrderNumber).FontNormal()
	if in.TableLabel != "" {
		b.TextLn(in.TableLabel)
	}
	if in.WaiterName != "" {
		b.TextLnf("Официант: %s", in.WaiterName)
	}
	b.TextLnf("Время:    %s", in.CreatedAt.Format("15:04"))
	b.Text(dashes(cols)).LF()

	for _, it := range in.Items {
		b.FontDouble().TextLnf("%d × %s", it.Qty, it.Name).FontNormal()
		for _, m := range it.Modifiers {
			b.TextLnf("  + %s", m)
		}
		if it.Comment != "" {
			b.TextLnf("  ! %s", it.Comment)
		}
	}

	if in.Comment != "" {
		b.Text(dashes(cols)).LF()
		b.Bold(true).TextLn("Комментарий:").Bold(false)
		b.TextLn(in.Comment)
	}

	b.Feed(3).CutFull()
	return b.Bytes()
}

// CancelRunnerInput — отмена позиций на кухне.
type CancelRunnerInput struct {
	Station     string
	OrderNumber int
	TableLabel  string
	CancelledAt time.Time
	Items       []RunnerItem // те же поля, но печатаем «ОТМЕНА»
	Reason      string
	Cols        int
}

// CancelRunnerLayout — отмена позиций. Большой акцент, чтобы повар не пропустил.
func CancelRunnerLayout(in CancelRunnerInput) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	b := NewBuilder().Init().CodePageCP866().CharsetRussia()

	b.AlignCenter().FontDouble().Bold(true).TextLn("!!! ОТМЕНА !!!").FontNormal().Bold(false)
	b.LF()
	b.AlignLeft().FontDouble().TextLnf("Заказ № %d", in.OrderNumber).FontNormal()
	if in.TableLabel != "" {
		b.TextLn(in.TableLabel)
	}
	b.TextLn(in.Station)
	b.TextLnf("Время:    %s", in.CancelledAt.Format("15:04"))
	b.Text(dashes(cols)).LF()

	for _, it := range in.Items {
		b.FontDouble().TextLnf("× %d  %s", it.Qty, it.Name).FontNormal()
	}
	if in.Reason != "" {
		b.LF().Bold(true).TextLn("Причина:").Bold(false).TextLn(in.Reason)
	}

	b.Feed(3).CutFull()
	return b.Bytes()
}

// ReportInput — общие поля для X/Z-отчёта.
type ReportInput struct {
	RestaurantName string
	ShiftNumber    string // строка, может быть просто id или дата
	OpenedAt       time.Time
	ClosedAt       time.Time // нулевое для X-отчёта
	OpeningBalance decimal.Decimal
	CashRevenue    decimal.Decimal
	CardRevenue    decimal.Decimal
	OrdersCount    int
	AvgCheck       decimal.Decimal
	ExpectedCash   decimal.Decimal
	ClosingBalance decimal.Decimal // нулевое для X
	CashierName    string
	Cols           int
}

// XReportLayout — промежуточный отчёт (без обнуления). По нажатию кассира.
func XReportLayout(in ReportInput) []byte {
	return reportLayout(in, "X-ОТЧЁТ", false)
}

// ZReportLayout — финальный отчёт при закрытии смены.
func ZReportLayout(in ReportInput) []byte {
	return reportLayout(in, "Z-ОТЧЁТ", true)
}

func reportLayout(in ReportInput, title string, withClosing bool) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	b := NewBuilder().Init().CodePageCP866().CharsetRussia()

	b.AlignCenter().FontDouble().Bold(true).TextLn(title).Bold(false).FontNormal()
	b.TextLn(in.RestaurantName).LF()

	b.AlignLeft()
	b.TextLnf("Смена:   %s", in.ShiftNumber)
	b.TextLnf("Открыта: %s", in.OpenedAt.Format("02.01.2006 15:04"))
	if withClosing && !in.ClosedAt.IsZero() {
		b.TextLnf("Закрыта: %s", in.ClosedAt.Format("02.01.2006 15:04"))
	}
	if in.CashierName != "" {
		b.TextLnf("Кассир:  %s", in.CashierName)
	}
	b.Text(dashes(cols)).LF()

	b.TextLn(PadRow("Остаток на начало:", decToShort(in.OpeningBalance), cols))
	b.TextLn(PadRow("Кол-во чеков:", strconv.Itoa(in.OrdersCount), cols))
	b.TextLn(PadRow("Средний чек:", decToShort(in.AvgCheck), cols))
	b.LF()
	b.TextLn(PadRow("Наличная выручка:", decToShort(in.CashRevenue), cols))
	b.TextLn(PadRow("Безнал. выручка:", decToShort(in.CardRevenue), cols))
	total := decimal.Add(in.CashRevenue, in.CardRevenue)
	b.Bold(true).TextLn(PadRow("Выручка ИТОГО:", decToShort(total), cols)).Bold(false)
	b.LF()

	if withClosing {
		b.TextLn(PadRow("Ожидается касса:", decToShort(in.ExpectedCash), cols))
		b.TextLn(PadRow("Фактически в кассе:", decToShort(in.ClosingBalance), cols))
		diff := decimal.Sub(in.ClosingBalance, in.ExpectedCash)
		b.Bold(true).TextLn(PadRow("Расхождение:", decToShort(diff), cols)).Bold(false)
	}

	b.LF().AlignCenter().TextLnf("Отпечатан: %s", nowFn().Format("02.01.2006 15:04"))
	b.Feed(3).CutFull()
	return b.Bytes()
}

// ─── helpers ──────────────────────────────────────────────────────────────

func dashes(n int) string {
	if n <= 0 {
		return ""
	}
	out := make([]byte, n)
	for i := range out {
		out[i] = '-'
	}
	return string(out)
}

// decToShort — Decimal → "1234.50" (2 знака после запятой) для чеков.
// 4 знака избыточно для печати; округляем half-even.
func decToShort(d decimal.Decimal) string {
	return d.RoundBank(2).String()
}

// qtyAsInt — для чека qty чаще целое (1, 2, 3 порции). Если weight (0.5),
// возвращаем int(0) — но в чеке мы покажем «1 × ...». Для weighted блюд
// printer-layout мы расширим в Phase 4.5.
func qtyAsInt(q decimal.Decimal) int {
	f, _ := q.Float64()
	if f < 1 {
		return 1
	}
	return int(f)
}

// paymentLabel — человеческая надпись по типу оплаты.
func paymentLabel(method string) string {
	switch method {
	case "cash":
		return "Наличными"
	case "card":
		return "Картой"
	case "transfer":
		return "Переводом"
	default:
		return method
	}
}
