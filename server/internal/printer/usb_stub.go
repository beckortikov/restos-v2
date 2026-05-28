//go:build !usb

package printer

import (
	"context"
	"errors"
)

// USB-драйвер требует libusb (gousb). Чтобы базовый билд не зависел от системной
// библиотеки, USB вынесен за build tag `usb`. Сборка с `-tags usb` подключит
// настоящую реализацию из usb_real.go (на следующей итерации).
//
// MVP кассирской станции на macOS dev → TCP-принтер (Epson TM-T20 LAN).
type USB struct {
	VendorID  uint16
	ProductID uint16
}

func NewUSB(vendor, product uint16) *USB { return &USB{VendorID: vendor, ProductID: product} }

func (u *USB) Name() string { return "usb:disabled" }

func (u *USB) Send(ctx context.Context, payload []byte) error {
	return errors.New("usb driver not enabled (rebuild with -tags usb)")
}
