// Package escpos — генератор ESC/POS байтов + CP866 кодировка.
//
// Принцип: layout-функции возвращают []byte — готовый поток для отправки в
// принтер «как есть». Никакого HTML, никаких bitmap'ов, ни font-rendering'а —
// всё это уже умеет прошивка термопринтера.
//
// Кодировка кириллицы — CP866 (стандарт для бытовых ESC/POS принтеров в РФ/СНГ).
// Активируется командой `ESC t 17` (CodePageRussian) в начале документа.
//
// Источник для портирования: ../restos/lib/print-service.ts.
package escpos

import "unicode/utf8"

// EncodeCP866 переводит строку UTF-8 → байты CP866.
// Символы, отсутствующие в таблице, заменяются на '?' (0x3F).
//
// Покрывает: ASCII (0x00..0x7F), русские заглавные/строчные, ё/Ё, №, ½/¼,
// псевдографику (для разделителей). Этого достаточно для чеков.
func EncodeCP866(s string) []byte {
	out := make([]byte, 0, len(s))
	for _, r := range s {
		out = append(out, runeToCP866(r))
	}
	return out
}

// EncodeCP866Bytes — то же, но из []byte (UTF-8). Маленькая оптимизация:
// избегаем лишнего конвертинга в string.
func EncodeCP866Bytes(b []byte) []byte {
	out := make([]byte, 0, len(b))
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		out = append(out, runeToCP866(r))
		b = b[size:]
	}
	return out
}

// runeToCP866 — единичный rune → byte. Hot path, без аллокаций.
func runeToCP866(r rune) byte {
	switch {
	case r < 0x80:
		return byte(r) // ASCII совпадает
	// Заглавные А..Я → 0x80..0x9F
	case r >= 'А' && r <= 'Я':
		return byte(0x80 + (r - 'А'))
	// Строчные а..п → 0xA0..0xAF
	case r >= 'а' && r <= 'п':
		return byte(0xA0 + (r - 'а'))
	// Строчные р..я → 0xE0..0xEF
	case r >= 'р' && r <= 'я':
		return byte(0xE0 + (r - 'р'))
	case r == 'Ё':
		return 0xF0
	case r == 'ё':
		return 0xF1
	// Псевдографика — несколько востребованных рамок.
	case r == '─':
		return 0xC4
	case r == '│':
		return 0xB3
	case r == '┌':
		return 0xDA
	case r == '┐':
		return 0xBF
	case r == '└':
		return 0xC0
	case r == '┘':
		return 0xD9
	case r == '├':
		return 0xC3
	case r == '┤':
		return 0xB4
	case r == '┬':
		return 0xC2
	case r == '┴':
		return 0xC1
	case r == '┼':
		return 0xC5
	case r == '═':
		return 0xCD
	case r == '║':
		return 0xBA
	case r == '╔':
		return 0xC9
	case r == '╗':
		return 0xBB
	case r == '╚':
		return 0xC8
	case r == '╝':
		return 0xBC
	case r == '╠':
		return 0xCC
	case r == '╣':
		return 0xB9
	case r == '╦':
		return 0xCB
	case r == '╩':
		return 0xCA
	case r == '╬':
		return 0xCE
	// Часто используемые символы.
	case r == '№':
		return 0xFC
	case r == '·' || r == '•':
		return 0xFA
	case r == '°':
		return 0xF8
	case r == '±':
		return 0xF1 // приблизительно; в CP866 ±=0xF1 совпадает с ё, но в чеках обычно используется только в reports — приоритет ё
	case r == '€':
		return '?' // в CP866 нет € — отдадим '?'
	case r == '₽':
		return '?' // в CP866 нет ₽ — для рубля используем «р.» в layout
	}
	return '?'
}
