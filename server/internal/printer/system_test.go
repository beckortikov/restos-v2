package printer

import (
	"context"
	"errors"
	"testing"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// TestNewSystemTrimsQueue — имя очереди приходит из формы, где легко поймать
// пробел копипастом из панели управления Windows. Пробел на конце даёт
// «принтер не найден» на пустом месте.
func TestNewSystemTrimsQueue(t *testing.T) {
	p := NewSystem("  POS-80 Printer  ")
	if p.Queue != "POS-80 Printer" {
		t.Fatalf("queue = %q, want %q", p.Queue, "POS-80 Printer")
	}
	if got, want := p.Name(), "system:POS-80 Printer"; got != want {
		t.Fatalf("Name() = %q, want %q", got, want)
	}
}

// TestSystemSendEmptyQueue — без имени очереди отправлять некуда, и это должна
// быть внятная ошибка, а не попытка достучаться до принтера с пустым именем.
func TestSystemSendEmptyQueue(t *testing.T) {
	err := NewSystem("   ").Send(context.Background(), []byte("x"))
	if !errors.Is(err, ErrNoSystemQueue) {
		t.Fatalf("err = %v, want ErrNoSystemQueue", err)
	}
}

// TestSystemSendEmptyPayload — пустой payload не повод дёргать спулер.
func TestSystemSendEmptyPayload(t *testing.T) {
	if err := NewSystem("POS-80").Send(context.Background(), nil); err != nil {
		t.Fatalf("empty payload: unexpected error %v", err)
	}
}

// TestSystemSendRespectsCanceledContext — очередь печати даёт драйверу 30s
// таймаут; отменённый контекст не должен уходить в syscall.
func TestSystemSendRespectsCanceledContext(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	err := NewSystem("POS-80").Send(ctx, []byte("x"))
	if !errors.Is(err, context.Canceled) {
		t.Fatalf("err = %v, want context.Canceled", err)
	}
}

// TestFromRowSystem — маппинг строки БД в драйвер.
func TestFromRowSystem(t *testing.T) {
	drv, err := FromRow(&models.Printer{ID: "p1", Driver: "system", Target: "POS-80"})
	if err != nil {
		t.Fatalf("FromRow: %v", err)
	}
	sp, ok := drv.(*SystemPrinter)
	if !ok {
		t.Fatalf("FromRow returned %T, want *SystemPrinter", drv)
	}
	if sp.Queue != "POS-80" {
		t.Fatalf("queue = %q, want POS-80", sp.Queue)
	}
}

// TestFromRowSystemEmptyTarget — принтер без очереди не должен молча
// собраться: иначе job уходит в спулер с пустым именем и теряется.
func TestFromRowSystemEmptyTarget(t *testing.T) {
	if _, err := FromRow(&models.Printer{ID: "p1", Driver: "system", Target: "  "}); err == nil {
		t.Fatal("FromRow: want error for empty system target, got nil")
	}
}

// TestFromRowExistingDriversUnchanged — новый драйвер не должен задевать
// существующие: tcp/virtual/mock собираются ровно как раньше.
func TestFromRowExistingDriversUnchanged(t *testing.T) {
	cases := []struct {
		driver, target string
		want           string
	}{
		{"tcp", "192.168.1.50", "tcp:192.168.1.50:9100"},
		{"virtual", "/tmp/printer", "virtual:/tmp/printer"},
		{"mock", "", "mock"},
	}
	for _, c := range cases {
		drv, err := FromRow(&models.Printer{ID: "p1", Driver: c.driver, Target: c.target})
		if err != nil {
			t.Fatalf("driver %s: %v", c.driver, err)
		}
		if got := drv.Name(); got != c.want {
			t.Fatalf("driver %s: Name() = %q, want %q", c.driver, got, c.want)
		}
	}
}
