package escpos

import (
	"encoding/hex"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Golden-тесты: каждый layout сериализуется в hex и сравнивается со
// snapshot-файлом в testdata/. Малейшее изменение байтов (например, опечатка
// в шаблоне) роняет тест.
//
// Обновление эталонов (после намеренного изменения layout):
//
//	UPDATE_GOLDEN=1 go test ./internal/escpos/...
//
// Эталоны коммитятся в git — это часть контракта печати.

const goldenDir = "testdata"

// fixedTime — стабильная дата для эталонов.
var fixedTime = time.Date(2026, 5, 25, 14, 30, 0, 0, time.UTC)

// В проде чеки печатаются в местном поясе кассы (displayLoc = time.Local).
// fixedTime — UTC, поэтому в тестах пиним displayLoc на UTC, иначе вывод
// зависел бы от TZ раннера и golden-файлы ломались бы где попало.
func init() { displayLoc = time.UTC }

func TestGolden_Receipt(t *testing.T) {
	in := ReceiptInput{
		RestaurantName: "Ресторан Старая Душанбе",
		RestaurantAddr: "ул. Рудаки, 100",
		OrderNumber:    42,
		OpenedAt:       fixedTime,
		ClosedAt:       fixedTime.Add(40 * time.Minute),
		CashierName:    "Анна",
		WaiterName:     "Иван",
		TableLabel:     "Стол 5",
		Items: []ReceiptItem{
			{Name: "Плов из говядины", Qty: decimal.MustFromString("2"), Price: decimal.MustFromString("45"), LineTotal: decimal.MustFromString("90")},
			{Name: "Чай зелёный", Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("10"), LineTotal: decimal.MustFromString("10")},
		},
		Subtotal:      decimal.MustFromString("100"),
		ServiceAmount: decimal.MustFromString("10"),
		Total:         decimal.MustFromString("110"),
		PaymentMethod: "cash",
	}
	assertGolden(t, "receipt_simple.hex", ReceiptLayout(in))
}

func TestGolden_Runner(t *testing.T) {
	in := RunnerInput{
		Station:     "Горячий цех",
		OrderNumber: 42,
		TableLabel:  "Стол 5",
		WaiterName:  "Иван",
		CreatedAt:   fixedTime,
		Items: []RunnerItem{
			{Name: "Плов из говядины", Qty: 2, Modifiers: []string{"без лука"}, Comment: "очень острый"},
			{Name: "Шашлык куриный", Qty: 1},
		},
	}
	assertGolden(t, "runner_simple.hex", RunnerLayout(in))
}

// Фастфуд (tables_enabled=false): гость забирает заказ по номеру, поэтому
// номер печатается крупно (6×) шапкой чека, а «Чек №» в мете не дублируется.
// Фастфуд: официантов нет, заказ принимает кассир. WaiterName здесь задан
// НАРОЧНО — в фастфуд-заказе он может быть проставлен (кассир числится
// официантом), но на гостевой чек строка «Официант» печататься не должна:
// она дублировала бы «Кассир» тем же именем. Эталон ниже эту строку не
// содержит — если она вернётся в вывод, тест упадёт.
func TestGolden_ReceiptFastFood(t *testing.T) {
	in := ReceiptInput{
		RestaurantName: "Бургер Хаус",
		RestaurantAddr: "пр. Сомони, 12",
		OrderNumber:    42,
		OpenedAt:       fixedTime,
		ClosedAt:       fixedTime.Add(4 * time.Minute),
		WaiterName:     "Нафиса",
		CashierName:    "Нафиса",
		FastFood:       true,
		Items: []ReceiptItem{
			{Name: "Бургер Классик", Qty: decimal.MustFromString("2"), Price: decimal.MustFromString("35"), LineTotal: decimal.MustFromString("70")},
			{Name: "Картофель фри", Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("18"), LineTotal: decimal.MustFromString("18")},
		},
		Subtotal:      decimal.MustFromString("88"),
		Total:         decimal.MustFromString("88"),
		PaymentMethod: "cash",
	}
	assertGolden(t, "receipt_fastfood.hex", ReceiptLayout(in))
}

// Доставка: контакты клиента (телефон/адрес) печатаются на ГОСТЕВОМ чеке —
// курьер забирает еду вместе с чеком. На кухонный бегунок они не идут.
func TestGolden_ReceiptDelivery(t *testing.T) {
	in := ReceiptInput{
		RestaurantName:  "Пицца Экспресс",
		OrderNumber:     77,
		OpenedAt:        fixedTime,
		ClosedAt:        fixedTime.Add(6 * time.Minute),
		CashierName:     "Диана",
		TableLabel:      "Доставка",
		DeliveryPhone:   "+992 900 11 22 33",
		DeliveryAddress: "ул. Айни, 24, кв. 12, 3 этаж",
		Items: []ReceiptItem{
			{Name: "Пицца Пепперони", Qty: decimal.MustFromString("1"), Price: decimal.MustFromString("60"), LineTotal: decimal.MustFromString("60")},
		},
		Subtotal:      decimal.MustFromString("60"),
		Total:         decimal.MustFromString("60"),
		PaymentMethod: "card",
	}
	assertGolden(t, "receipt_delivery.hex", ReceiptLayout(in))
}

// Фастфуд-ранер: номер заказа вместо станции шапкой (6×) — повар собирает
// заказ по нему; станция уходит подписью, «Зак: N» в строке не дублируется.
func TestGolden_RunnerFastFood(t *testing.T) {
	in := RunnerInput{
		Station:     "Кухня",
		OrderNumber: 42,
		OrderType:   "С собой",
		WaiterName:  "Нафиса",  // на фастфуд-бегунке НЕ печатается (убрано)
		TableLabel:  "3 гост.", // число гостей на кухне НЕ печатается (убрано)
		CreatedAt:   fixedTime,
		FastFood:    true,
		Items: []RunnerItem{
			{Name: "Бургер Классик", Qty: 2, Modifiers: []string{"без лука"}},
			{Name: "Картофель фри", Qty: 1},
			{Name: "Кола 0.5", Qty: 1, Comment: "со льдом"},
		},
	}
	assertGolden(t, "runner_fastfood.hex", RunnerLayout(in))
}

func TestGolden_CancelRunner(t *testing.T) {
	in := CancelRunnerInput{
		Station:     "Горячий цех",
		OrderNumber: 42,
		TableLabel:  "Стол 5",
		CancelledAt: fixedTime,
		Items: []RunnerItem{
			{Name: "Плов из говядины", Qty: 2},
		},
		Reason: "Клиент отказался",
	}
	assertGolden(t, "cancel_runner_simple.hex", CancelRunnerLayout(in))
}

func TestGolden_XReport(t *testing.T) {
	in := ReportInput{
		RestaurantName: "Ресторан Старая Душанбе",
		ShiftNumber:    "2026-05-25 / shift-1",
		OpenedAt:       fixedTime,
		OpeningBalance: decimal.MustFromString("1000"),
		CashRevenue:    decimal.MustFromString("5400"),
		CardRevenue:    decimal.MustFromString("3200"),
		OrdersCount:    18,
		AvgCheck:       decimal.MustFromString("477.78"),
		CashierName:    "Анна",
	}
	// X-отчёт печатается во время смены — fixedTime в reportLayout берётся
	// time.Now() для "Отпечатан:". Чтобы golden был детерминирован, monkeypatch'нем
	// time.Now через мини-обёртку — в layouts.go используется time.Now() прямо.
	// Для теста подменим через test-helper.
	withFixedNow(t, fixedTime.Add(2*time.Hour), func() {
		assertGolden(t, "xreport_simple.hex", XReportLayout(in))
	})
}

func TestGolden_ZReport(t *testing.T) {
	in := ReportInput{
		RestaurantName: "Ресторан Старая Душанбе",
		ShiftNumber:    "2026-05-25 / shift-1",
		OpenedAt:       fixedTime,
		ClosedAt:       fixedTime.Add(8 * time.Hour),
		OpeningBalance: decimal.MustFromString("1000"),
		CashRevenue:    decimal.MustFromString("5400"),
		CardRevenue:    decimal.MustFromString("3200"),
		OrdersCount:    18,
		AvgCheck:       decimal.MustFromString("477.78"),
		ExpectedCash:   decimal.MustFromString("6400"),
		ClosingBalance: decimal.MustFromString("6380"),
		CashierName:    "Анна",
	}
	withFixedNow(t, fixedTime.Add(8*time.Hour), func() {
		assertGolden(t, "zreport_simple.hex", ZReportLayout(in))
	})
}

// Чек «Обслуживание официантов» за смену.
func TestGolden_ServiceReport(t *testing.T) {
	in := ServiceReportInput{
		RestaurantName: "Ресторан Старая Душанбе",
		ShiftNumber:    "2026-05-25 / shift-1",
		OpenedAt:       fixedTime,
		ClosedAt:       fixedTime.Add(8 * time.Hour),
		Waiters: []ServiceWaiterLine{
			{Name: "Иван", Accrued: decimal.MustFromString("320"), Paid: decimal.MustFromString("200"), ToPay: decimal.MustFromString("120")},
			{Name: "Мария", Accrued: decimal.MustFromString("150"), Paid: decimal.MustFromString("0"), ToPay: decimal.MustFromString("150")},
		},
	}
	withFixedNow(t, fixedTime.Add(8*time.Hour), func() {
		assertGolden(t, "service_report.hex", ServiceReportLayout(in))
	})
}

// Z-отчёт с блоком «Движение по кассе»: внесения, изъятия, расходы по категориям.
func TestGolden_ZReportWithMovement(t *testing.T) {
	in := ReportInput{
		RestaurantName: "Ресторан Старая Душанбе",
		ShiftNumber:    "2026-05-25 / shift-1",
		OpenedAt:       fixedTime,
		ClosedAt:       fixedTime.Add(8 * time.Hour),
		OpeningBalance: decimal.MustFromString("1000"),
		CashRevenue:    decimal.MustFromString("5400"),
		CardRevenue:    decimal.MustFromString("3200"),
		OrdersCount:    18,
		AvgCheck:       decimal.MustFromString("477.78"),
		ExpectedCash:   decimal.MustFromString("5980"),
		ClosingBalance: decimal.MustFromString("5980"),
		CashierName:    "Анна",
		CashIn:         decimal.MustFromString("500"),
		Withdrawals:    decimal.MustFromString("300"),
		Expenses: []ReportExpenseLine{
			{Category: "Закупка продуктов", Amount: decimal.MustFromString("450")},
			{Category: "Хозтовары", Amount: decimal.MustFromString("170")},
		},
	}
	withFixedNow(t, fixedTime.Add(8*time.Hour), func() {
		assertGolden(t, "zreport_movement.hex", ZReportLayout(in))
	})
}

// ─── helpers ──────────────────────────────────────────────────────────────

// assertGolden сравнивает actual с testdata/<name>. Hex-эталон удобен для
// просмотра в обычном текстовом редакторе и для code review через PR.
func assertGolden(t *testing.T, name string, actual []byte) {
	t.Helper()
	path := filepath.Join(goldenDir, name)
	hexEncoded := hex.EncodeToString(actual)
	// Формат файла — hex (32 байта в строку, чтобы glancing eyes видели картину).
	formatted := formatHex(hexEncoded)

	if os.Getenv("UPDATE_GOLDEN") == "1" {
		if err := os.MkdirAll(goldenDir, 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(formatted), 0o644); err != nil {
			t.Fatal(err)
		}
		t.Logf("UPDATED %s (%d bytes)", path, len(actual))
		return
	}

	wantBytes, err := os.ReadFile(path)
	if err != nil {
		t.Fatalf("missing golden %s: run with UPDATE_GOLDEN=1 (%v)", path, err)
	}
	if string(wantBytes) != formatted {
		t.Errorf("golden mismatch for %s\nrun: UPDATE_GOLDEN=1 go test ./internal/escpos/...\n--- diff (first 200 chars):\nwant: %s...\ngot:  %s...",
			path,
			truncate(string(wantBytes), 200),
			truncate(formatted, 200),
		)
	}
}

func formatHex(s string) string {
	var b strings.Builder
	for i := 0; i < len(s); i += 64 {
		end := i + 64
		if end > len(s) {
			end = len(s)
		}
		b.WriteString(s[i:end])
		b.WriteByte('\n')
	}
	return b.String()
}

func truncate(s string, n int) string {
	if len(s) <= n {
		return s
	}
	return s[:n]
}

// withFixedNow — подменяет time.Now (через unexported testHook в layouts.go).
// См. layouts_testhook.go.
func withFixedNow(t *testing.T, ts time.Time, fn func()) {
	t.Helper()
	old := nowFn
	nowFn = func() time.Time { return ts }
	defer func() { nowFn = old }()
	fn()
}
