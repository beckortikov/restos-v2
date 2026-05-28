package escpos

import "time"

// TestPageInput — параметры пробной страницы.
type TestPageInput struct {
	PrinterName string
	Station     string // пусто для receipt-принтеров
	Cols        int
	Now         time.Time
}

// TestPageLayout — короткий чек для проверки настройки принтера.
//
// Печатает:
//   - крупный заголовок «ТЕСТ ПЕЧАТИ»;
//   - имя принтера + станцию;
//   - алфавиты (русский+латиница+цифры) для визуальной проверки кодировки;
//   - штрих-код CODE128 (проверка sharpness);
//   - дату/время и cut.
//
// Если на распечатке кракозябры — кодировка/charset сбиты.
// Если штрих-код смазан — голова грязная или drum изношен.
func TestPageLayout(in TestPageInput) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	now := in.Now
	if now.IsZero() {
		now = time.Now()
	}

	b := NewBuilder().Init().CodePageCP866().CharsetRussia()

	b.AlignCenter().FontDouble().Bold(true).TextLn("ТЕСТ ПЕЧАТИ").Bold(false).FontNormal()
	b.LF()
	b.AlignLeft()
	b.TextLnf("Принтер: %s", in.PrinterName)
	if in.Station != "" {
		b.TextLnf("Станция: %s", in.Station)
	}
	b.TextLnf("Время:   %s", now.Format("02.01.2006 15:04:05"))
	b.Text(dashes(cols)).LF()

	b.TextLn("Кириллица:")
	b.TextLn("АБВГДЕЁЖЗИЙКЛМНОПРСТУФХЦЧШЩЪЫЬЭЮЯ")
	b.TextLn("абвгдеёжзийклмнопрстуфхцчшщъыьэюя")
	b.LF()
	b.TextLn("Latin: ABCDEFGHIJKLMNOPQRSTUVWXYZ")
	b.TextLn("       abcdefghijklmnopqrstuvwxyz")
	b.TextLn("Digits: 0123456789")
	b.TextLn("Punct:  . , : ; ! ? ( ) - / № %")
	b.Text(dashes(cols)).LF()

	b.TextLn("Размеры шрифта:")
	b.TextLn("[normal]      обычный")
	b.FontDouble().TextLn("[double]      крупный").FontNormal()
	b.Bold(true).TextLn("[bold]        жирный").Bold(false)
	b.Underline(1).TextLn("[underline]   подчёркнутый").Underline(0)
	b.Text(dashes(cols)).LF()

	b.AlignCenter().TextLn("Штрих-код CODE128:").BarcodeCode128("RESTOS-PRINT-OK")
	b.LF().LF()
	b.TextLn("Если всё видно чётко —")
	b.TextLn("принтер настроен правильно.")
	b.LF().Feed(3).CutFull()
	return b.Bytes()
}
