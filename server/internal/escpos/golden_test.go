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
