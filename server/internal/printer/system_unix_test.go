//go:build !windows

package printer

import "testing"

// TestParseLpstat — разбор `lpstat -p -d`. Формат зафиксирован LC_ALL=C,
// поэтому опираться на ключевые слова можно.
func TestParseLpstat(t *testing.T) {
	const out = `printer POS-80 is idle.  enabled since Mon 20 Jul 2026 10:00:00
printer Kitchen_Star is printing.  enabled since Mon 20 Jul 2026 09:12:41
system default destination: POS-80`

	got := parseLpstat(out)
	if len(got) != 2 {
		t.Fatalf("got %d queues, want 2: %+v", len(got), got)
	}
	if got[0].Name != "POS-80" || got[0].Status != "idle" || !got[0].IsDefault {
		t.Fatalf("queue[0] = %+v", got[0])
	}
	if got[1].Name != "Kitchen_Star" || got[1].Status != "printing" || got[1].IsDefault {
		t.Fatalf("queue[1] = %+v", got[1])
	}
}

// TestParseLpstatNoPrinters — на машине без принтеров lpstat печатает
// «lpstat: No destinations added.» и выходит с ненулевым кодом. Пустой
// список — валидный ответ, а не ошибка.
func TestParseLpstatNoPrinters(t *testing.T) {
	got := parseLpstat("lpstat: No destinations added.\n")
	if got == nil {
		t.Fatal("parseLpstat returned nil, want empty slice (JSON [] instead of null)")
	}
	if len(got) != 0 {
		t.Fatalf("got %d queues, want 0: %+v", len(got), got)
	}
}

// TestParseLpstatNoDefault — принтеры есть, дефолтного нет.
func TestParseLpstatNoDefault(t *testing.T) {
	got := parseLpstat("printer POS-80 is idle.  enabled since Mon 20 Jul 2026 10:00:00\n")
	if len(got) != 1 {
		t.Fatalf("got %d queues, want 1", len(got))
	}
	if got[0].IsDefault {
		t.Fatalf("queue[0].IsDefault = true, want false")
	}
}

// TestParseLpstatUnknownStatus — если строка не в ожидаемом формате, имя
// всё равно должно распознаться: без имени очередь бесполезна, без статуса —
// вполне работает.
func TestParseLpstatUnknownStatus(t *testing.T) {
	got := parseLpstat("printer POS-80\n")
	if len(got) != 1 || got[0].Name != "POS-80" {
		t.Fatalf("got %+v, want one queue named POS-80", got)
	}
	if got[0].Status != "" {
		t.Fatalf("status = %q, want empty", got[0].Status)
	}
}
