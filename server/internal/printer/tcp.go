package printer

import (
	"context"
	"fmt"
	"net"
	"time"
)

// TCPPrinter — самый частый кейс: сетевой принтер на порту 9100 (или другом).
// Подключение per-job (не keepalive): термопринтеры часто закрывают idle-сокеты,
// и open-on-demand надёжнее.
type TCPPrinter struct {
	Addr         string        // "192.168.1.50:9100"
	DialTimeout  time.Duration // default 3s
	WriteTimeout time.Duration // default 5s
}

// NewTCP создаёт принтер. Минимум — addr.
func NewTCP(addr string) *TCPPrinter {
	return &TCPPrinter{
		Addr:         addr,
		DialTimeout:  3 * time.Second,
		WriteTimeout: 5 * time.Second,
	}
}

func (p *TCPPrinter) Name() string { return "tcp:" + p.Addr }

func (p *TCPPrinter) Send(ctx context.Context, payload []byte) error {
	dialer := net.Dialer{Timeout: p.DialTimeout}
	conn, err := dialer.DialContext(ctx, "tcp", p.Addr)
	if err != nil {
		return fmt.Errorf("tcp dial %s: %w", p.Addr, err)
	}
	defer conn.Close()

	if p.WriteTimeout > 0 {
		_ = conn.SetWriteDeadline(time.Now().Add(p.WriteTimeout))
	}
	if _, err := conn.Write(payload); err != nil {
		return fmt.Errorf("tcp write %s: %w", p.Addr, err)
	}
	// Большинство термопринтеров не отвечают подтверждением — после Write
	// просто закрываем сокет. Если нужна real-time status — отдельный protocol
	// (DLE EOT) — out of scope для MVP.
	return nil
}
