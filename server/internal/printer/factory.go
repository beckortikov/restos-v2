package printer

import (
	"fmt"
	"strings"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// FromRow строит Printer-driver из БД-записи `printers`.
//
//	tcp     → NewTCP(target)
//	virtual → NewVirtual(target) (target — путь к директории)
//	mock    → NewMock()  (target игнорируется; для тестов)
//	usb     → NewUSB(vid, pid)  где target="04b8:0202"
//
// На неизвестный driver возвращает ошибку.
func FromRow(p *models.Printer) (Printer, error) {
	switch p.Driver {
	case "tcp":
		if p.Target == "" {
			return nil, fmt.Errorf("printer %s: tcp target is empty", p.ID)
		}
		return NewTCP(p.Target), nil
	case "virtual":
		dir := p.Target
		if dir == "" {
			dir = "./virtual-printer-" + p.ID
		}
		return NewVirtual(dir), nil
	case "mock":
		return NewMock(), nil
	case "usb":
		var vid, pid uint16
		parts := strings.SplitN(p.Target, ":", 2)
		if len(parts) != 2 {
			return nil, fmt.Errorf("printer %s: usb target must be vid:pid", p.ID)
		}
		if _, err := fmt.Sscanf(parts[0], "%x", &vid); err != nil {
			return nil, fmt.Errorf("printer %s: bad vid: %w", p.ID, err)
		}
		if _, err := fmt.Sscanf(parts[1], "%x", &pid); err != nil {
			return nil, fmt.Errorf("printer %s: bad pid: %w", p.ID, err)
		}
		return NewUSB(vid, pid), nil
	default:
		return nil, fmt.Errorf("printer %s: unknown driver %q", p.ID, p.Driver)
	}
}
