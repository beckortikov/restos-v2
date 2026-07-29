//go:build windows

package printer

import (
	"context"
	"fmt"
	"strings"
	"unsafe"

	"golang.org/x/sys/windows"
)

// Печать через спулер Windows (winspool.drv). Чистые syscall'ы — cgo не нужен,
// сборка остаётся CGO_ENABLED=0.
//
// Ключевой момент — datatype "RAW" в DOC_INFO_1: спулер не пытается
// отрендерить документ через драйвер принтера, а отдаёт байты в порт как есть.
// Это ровно то, что нужно для ESC/POS: layout уже собран в escpos.Builder.
var (
	winspool = windows.NewLazySystemDLL("winspool.drv")

	procOpenPrinter       = winspool.NewProc("OpenPrinterW")
	procClosePrinter      = winspool.NewProc("ClosePrinter")
	procStartDocPrinter   = winspool.NewProc("StartDocPrinterW")
	procEndDocPrinter     = winspool.NewProc("EndDocPrinter")
	procStartPagePrinter  = winspool.NewProc("StartPagePrinter")
	procEndPagePrinter    = winspool.NewProc("EndPagePrinter")
	procWritePrinter      = winspool.NewProc("WritePrinter")
	procEnumPrinters      = winspool.NewProc("EnumPrintersW")
	procGetDefaultPrinter = winspool.NewProc("GetDefaultPrinterW")
)

const (
	printerEnumLocal       = 0x00000002
	printerEnumConnections = 0x00000004
)

// docInfo1W — DOC_INFO_1W из winspool.
type docInfo1W struct {
	DocName    *uint16
	OutputFile *uint16
	Datatype   *uint16
}

// printerInfo4W — PRINTER_INFO_4W. Level 4 — самый дешёвый уровень
// перечисления (не лезет в порт и драйвер, отдаёт только имя).
type printerInfo4W struct {
	PrinterName *uint16
	ServerName  *uint16
	Attributes  uint32
}

// sendToSystemQueue пишет payload в очередь через winspool.
//
// Вызовы winspool блокирующие и не умеют отменяться, поэтому крутим их в
// горутине и слушаем ctx. При таймауте возвращаем управление очереди печати,
// а сам WritePrinter досчитывается в фоне — спулер в любом случае доведёт
// начатый job до порта или отменит его сам.
func sendToSystemQueue(ctx context.Context, queue string, payload []byte) error {
	done := make(chan error, 1)
	go func() { done <- writeRaw(queue, payload) }()
	select {
	case err := <-done:
		return err
	case <-ctx.Done():
		return fmt.Errorf("system printer %q: %w", queue, ctx.Err())
	}
}

func writeRaw(queue string, payload []byte) error {
	name, err := windows.UTF16PtrFromString(queue)
	if err != nil {
		return fmt.Errorf("system printer %q: bad queue name: %w", queue, err)
	}

	var h windows.Handle
	r, _, e := procOpenPrinter.Call(
		uintptr(unsafe.Pointer(name)),
		uintptr(unsafe.Pointer(&h)),
		0,
	)
	if r == 0 {
		return fmt.Errorf("system printer %q: OpenPrinter: %w", queue, e)
	}
	defer procClosePrinter.Call(uintptr(h)) //nolint:errcheck // cleanup

	docName, err := windows.UTF16PtrFromString("RestOS ESC/POS")
	if err != nil {
		return fmt.Errorf("system printer %q: doc name: %w", queue, err)
	}
	rawType, err := windows.UTF16PtrFromString("RAW")
	if err != nil {
		return fmt.Errorf("system printer %q: datatype: %w", queue, err)
	}
	di := docInfo1W{DocName: docName, Datatype: rawType}

	r, _, e = procStartDocPrinter.Call(uintptr(h), 1, uintptr(unsafe.Pointer(&di)))
	if r == 0 {
		return fmt.Errorf("system printer %q: StartDocPrinter: %w", queue, e)
	}
	defer procEndDocPrinter.Call(uintptr(h)) //nolint:errcheck // cleanup

	r, _, e = procStartPagePrinter.Call(uintptr(h))
	if r == 0 {
		return fmt.Errorf("system printer %q: StartPagePrinter: %w", queue, e)
	}
	defer procEndPagePrinter.Call(uintptr(h)) //nolint:errcheck // cleanup

	// WritePrinter может принять меньше, чем отдали (внутренний буфер спулера),
	// поэтому дописываем хвост в цикле.
	for off := 0; off < len(payload); {
		var written uint32
		chunk := payload[off:]
		r, _, e = procWritePrinter.Call(
			uintptr(h),
			uintptr(unsafe.Pointer(&chunk[0])),
			uintptr(len(chunk)),
			uintptr(unsafe.Pointer(&written)),
		)
		if r == 0 {
			return fmt.Errorf("system printer %q: WritePrinter at %d/%d: %w",
				queue, off, len(payload), e)
		}
		if written == 0 {
			return fmt.Errorf("system printer %q: spooler accepted 0 bytes at %d/%d",
				queue, off, len(payload))
		}
		off += int(written)
	}
	return nil
}

// listSystemQueues — EnumPrinters(level 4) + GetDefaultPrinter.
//
// PRINTER_ENUM_LOCAL — очереди самой машины (включая USB-принтер моноблока),
// PRINTER_ENUM_CONNECTIONS — подключённые сетевые очереди.
func listSystemQueues(_ context.Context) ([]SystemQueue, error) {
	const flags = printerEnumLocal | printerEnumConnections

	// Первый вызов — узнать размер буфера. Он всегда «падает» с
	// ERROR_INSUFFICIENT_BUFFER, нас интересует только needed.
	var needed, returned uint32
	procEnumPrinters.Call(flags, 0, 4, 0, 0, //nolint:errcheck // sizing probe
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)))
	if needed == 0 {
		return []SystemQueue{}, nil
	}

	buf := make([]byte, needed)
	r, _, e := procEnumPrinters.Call(flags, 0, 4,
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(needed),
		uintptr(unsafe.Pointer(&needed)),
		uintptr(unsafe.Pointer(&returned)))
	if r == 0 {
		return nil, fmt.Errorf("EnumPrinters: %w", e)
	}
	if returned == 0 {
		return []SystemQueue{}, nil
	}

	def := defaultQueueName()
	infos := unsafe.Slice((*printerInfo4W)(unsafe.Pointer(&buf[0])), int(returned))
	out := make([]SystemQueue, 0, len(infos))
	for i := range infos {
		n := windows.UTF16PtrToString(infos[i].PrinterName)
		if n == "" {
			continue
		}
		out = append(out, SystemQueue{
			Name:      n,
			IsDefault: def != "" && strings.EqualFold(n, def),
		})
	}
	return out, nil
}

func defaultQueueName() string {
	var n uint32
	procGetDefaultPrinter.Call(0, uintptr(unsafe.Pointer(&n))) //nolint:errcheck // sizing probe
	if n == 0 {
		return ""
	}
	buf := make([]uint16, n)
	r, _, _ := procGetDefaultPrinter.Call(
		uintptr(unsafe.Pointer(&buf[0])),
		uintptr(unsafe.Pointer(&n)))
	if r == 0 {
		return ""
	}
	return windows.UTF16ToString(buf)
}
