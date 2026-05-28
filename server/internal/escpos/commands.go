package escpos

import (
	"bytes"
	"fmt"
)

// Builder — accumulator байтов ESC/POS. Используется layout-функциями.
//
// Принцип: builder инкрементально пишет команды (Init, Align, Text, Cut...).
// Финальный .Bytes() — это и есть то, что отправляется в принтер.
type Builder struct {
	buf bytes.Buffer
}

func NewBuilder() *Builder { return &Builder{} }

// Bytes возвращает накопленный поток.
func (b *Builder) Bytes() []byte { return b.buf.Bytes() }

// Raw добавляет произвольные байты (для escape-hatch).
func (b *Builder) Raw(p ...byte) *Builder {
	b.buf.Write(p)
	return b
}

// ─── Initialization & charset ──────────────────────────────────────────────

// Init — ESC @. Сброс всех режимов в дефолт.
func (b *Builder) Init() *Builder { return b.Raw(0x1B, '@') }

// CodePageCP866 — ESC t 17. Выбор кодовой страницы 17 = CP866.
// На большинстве принтеров (Epson, Xprinter) это валидно.
func (b *Builder) CodePageCP866() *Builder { return b.Raw(0x1B, 't', 17) }

// CharsetRussia — ESC R 12. International character set = Russia.
// Влияет на trim'ы букв в зоне 0x00..0x1F (нужно вместе с CodePage).
func (b *Builder) CharsetRussia() *Builder { return b.Raw(0x1B, 'R', 12) }

// ─── Alignment ─────────────────────────────────────────────────────────────

// Align — ESC a {0=left,1=center,2=right}.
func (b *Builder) Align(a byte) *Builder { return b.Raw(0x1B, 'a', a) }

func (b *Builder) AlignLeft() *Builder   { return b.Align(0) }
func (b *Builder) AlignCenter() *Builder { return b.Align(1) }
func (b *Builder) AlignRight() *Builder  { return b.Align(2) }

// ─── Sizes & emphasis ──────────────────────────────────────────────────────

// FontSize — GS ! n. Биты 0..2 = высота (0..7), биты 4..6 = ширина (0..7).
// Стандарт: 0x00 = нормальный, 0x11 = double-width+double-height.
func (b *Builder) FontSize(n byte) *Builder { return b.Raw(0x1D, '!', n) }

func (b *Builder) FontNormal() *Builder { return b.FontSize(0x00) }
func (b *Builder) FontDouble() *Builder { return b.FontSize(0x11) }

// Bold — ESC E n (n=1 on, 0 off).
func (b *Builder) Bold(on bool) *Builder {
	if on {
		return b.Raw(0x1B, 'E', 1)
	}
	return b.Raw(0x1B, 'E', 0)
}

// Underline — ESC - n (0..2).
func (b *Builder) Underline(n byte) *Builder { return b.Raw(0x1B, '-', n) }

// ─── Text ─────────────────────────────────────────────────────────────────

// Text пишет строку (UTF-8) с CP866-кодировкой.
func (b *Builder) Text(s string) *Builder {
	b.buf.Write(EncodeCP866(s))
	return b
}

// TextLn — Text + LF.
func (b *Builder) TextLn(s string) *Builder {
	b.Text(s)
	return b.LF()
}

// LF — line feed (0x0A).
func (b *Builder) LF() *Builder { return b.Raw(0x0A) }

// Feed — n line feeds.
func (b *Builder) Feed(n byte) *Builder {
	if n == 0 {
		return b
	}
	return b.Raw(0x1B, 'd', n)
}

// ─── Paper ────────────────────────────────────────────────────────────────

// CutFull — GS V 0 (full cut, partial где-то по другому коду).
func (b *Builder) CutFull() *Builder { return b.Raw(0x1D, 'V', 0) }

// CutPartial — GS V 1.
func (b *Builder) CutPartial() *Builder { return b.Raw(0x1D, 'V', 1) }

// CutWithFeed — GS V B n. Промотать на n строк перед резом (рекомендуется,
// иначе верх следующего чека отрежется).
func (b *Builder) CutWithFeed(n byte) *Builder { return b.Raw(0x1D, 'V', 'B', n) }

// ─── Cash drawer ──────────────────────────────────────────────────────────

// DrawerKick — ESC p m t1 t2. m=0 (pin 2) или 1 (pin 5). Длительность импульса
// t1*2мс, пауза t2*2мс. Стандартные значения 50/50 = 100/100 мс.
func (b *Builder) DrawerKick(m, t1, t2 byte) *Builder {
	return b.Raw(0x1B, 'p', m, t1, t2)
}

// DrawerKickDefault — стандартный kick для большинства ящиков.
func (b *Builder) DrawerKickDefault() *Builder { return b.DrawerKick(0, 50, 50) }

// ─── Barcodes & QR ────────────────────────────────────────────────────────

// BarcodeCode128 печатает CODE128 штрих-код.
// GS k 73 n d1..dn — формат с длиной (n — длина данных, 1..255).
func (b *Builder) BarcodeCode128(data string) *Builder {
	if len(data) == 0 || len(data) > 255 {
		return b
	}
	b.Raw(0x1D, 'k', 73, byte(len(data)))
	b.buf.WriteString(data)
	return b
}

// QRCode печатает QR-код размером module=1..16 (стандарт 4..6 для чеков).
// Реализация — последовательность 4 команд GS ( k, см. ESC/POS spec.
func (b *Builder) QRCode(data string, moduleSize byte) *Builder {
	if moduleSize < 1 {
		moduleSize = 4
	}
	if moduleSize > 16 {
		moduleSize = 16
	}
	// 1. Function 165: select model (model 2).
	b.Raw(0x1D, '(', 'k', 4, 0, 49, 65, 50, 0)
	// 2. Function 167: set size of module.
	b.Raw(0x1D, '(', 'k', 3, 0, 49, 67, moduleSize)
	// 3. Function 169: set error correction (49=L, 50=M, 51=Q, 52=H).
	b.Raw(0x1D, '(', 'k', 3, 0, 49, 69, 49)
	// 4. Function 180: store data.
	n := len(data) + 3
	if n > 0xFFFF {
		return b
	}
	pL := byte(n & 0xFF)
	pH := byte((n >> 8) & 0xFF)
	b.Raw(0x1D, '(', 'k', pL, pH, 49, 80, 48)
	b.buf.WriteString(data)
	// 5. Function 181: print (Q stored data).
	b.Raw(0x1D, '(', 'k', 3, 0, 49, 81, 48)
	return b
}

// ─── Layout helpers ───────────────────────────────────────────────────────

// LineAcross80 — горизонтальная линия из дефисов на ширину 80mm бумаги (48 cols).
func (b *Builder) LineAcross80() *Builder { return b.TextLn(string(bytes.Repeat([]byte("-"), 48))) }

// LineAcross58 — для 58mm (32 cols).
func (b *Builder) LineAcross58() *Builder { return b.TextLn(string(bytes.Repeat([]byte("-"), 32))) }

// Helper для аккуратных line breaks внутри Builder с Sprintf.
func (b *Builder) Textf(format string, a ...any) *Builder {
	return b.Text(fmt.Sprintf(format, a...))
}

// TextLnf — печатает Sprintf + LF.
func (b *Builder) TextLnf(format string, a ...any) *Builder {
	return b.TextLn(fmt.Sprintf(format, a...))
}

// PadRow — две колонки фиксированной ширины width, левая колонка прижата
// влево, правая — вправо. Дополняется пробелами. Полезно для строк
// «название — цена».
func PadRow(left, right string, width int) string {
	if width <= 0 {
		return left + " " + right
	}
	llen := visibleRuneCount(left)
	rlen := visibleRuneCount(right)
	if llen+rlen >= width {
		return left + " " + right
	}
	pad := width - llen - rlen
	return left + spaces(pad) + right
}

// visibleRuneCount — длина в рунах (UTF-8 → rune count). Для CP866 после
// конверсии один rune = один byte, но при layout в UTF-8 считаем именно руны.
func visibleRuneCount(s string) int {
	c := 0
	for range s {
		c++
	}
	return c
}

func spaces(n int) string {
	if n <= 0 {
		return ""
	}
	b := make([]byte, n)
	for i := range b {
		b[i] = ' '
	}
	return string(b)
}
