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

// dropRune — sentinel значение возвращаемое runeToCP866 для символов, которые
// должны быть полностью отброшены (не выводить даже '?'): zero-width chars,
// эмодзи и пр. Используем impossible byte 0xFF как маркер — реально 0xFF в
// CP866 это «space» (NBSP-like) и в чеках нам не нужен.
const dropRune = byte(0xFF)

// EncodeCP866 переводит строку UTF-8 → байты CP866.
// Символы, отсутствующие в таблице, заменяются на '?' (0x3F) либо отбрасываются
// (эмодзи, zero-width). Для типографских символов («» — … × → и т.д.)
// делается ASCII-транслитерация (см. runeToCP866).
//
// Покрывает: ASCII (0x00..0x7F), русские заглавные/строчные, ё/Ё, №, ½/¼,
// псевдографику (для разделителей). Этого достаточно для чеков.
func EncodeCP866(s string) []byte {
	out := make([]byte, 0, len(s))
	for _, r := range s {
		b := runeToCP866(r)
		if b == dropRune {
			continue
		}
		out = append(out, b)
	}
	return out
}

// EncodeCP866Bytes — то же, но из []byte (UTF-8). Маленькая оптимизация:
// избегаем лишнего конвертинга в string.
func EncodeCP866Bytes(b []byte) []byte {
	out := make([]byte, 0, len(b))
	for len(b) > 0 {
		r, size := utf8.DecodeRune(b)
		c := runeToCP866(r)
		if c != dropRune {
			out = append(out, c)
		}
		b = b[size:]
	}
	return out
}

// runeToCP866 — единичный rune → byte. Hot path, без аллокаций.
// Возвращает dropRune (0xFF) для рун, которые следует полностью отбросить
// (эмодзи, zero-width). Возвращает '?' для неизвестных символов.
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
	// ─── ASCII-fallback'и для типографских символов ───────────────────────
	// Принтер их не умеет, отдаём максимально близкий ASCII. Соответствует
	// CP866_MAP в ../restos/lib/print-service.ts.
	case r == '—' || r == '–' || r == '−':
		// em-dash, en-dash, minus sign → '-'
		return '-'
	case r == '«' || r == '»' || r == '“' || r == '”' || r == '„':
		// guillemets и curly double quotes → '"'
		return '"'
	case r == '‘' || r == '’' || r == '‚' || r == '`':
		// curly single quotes, backtick → '
		return '\''
	case r == '…':
		// ellipsis — отдаём один '.'; если важно «...», в layout заменить заранее.
		return '.'
	case r == '×':
		return 'x'
	case r == '→' || r == '⇒' || r == '➔' || r == '➜':
		return '>'
	case r == '←' || r == '⇐':
		return '<'
	case r == '↑' || r == '⇑':
		return '^'
	case r == '↓' || r == '⇓':
		return 'v'
	case r == '✓' || r == '✔':
		return '+'
	case r == '✗' || r == '✘':
		return 'x'
	case r == '★' || r == '☆':
		return '*'
	case r == '€':
		// в CP866 нет € — отдадим 'E'. В layout'ах принято писать «EUR».
		return 'E'
	case r == '₽':
		// в CP866 нет ₽ — отдаём 'R'. В layout'ах принято писать «р.»
		return 'R'
	case r == ' ' || r == ' ' || r == ' ' || r == ' ' || r == ' ':
		// non-breaking space / narrow / thin / figure / hair space → regular space
		return ' '
	case r == '​' || r == '‌' || r == '‍' || r == '\ufeff':
		// zero-width: ZWSP, ZWNJ, ZWJ, BOM — полностью отбрасываем
		return dropRune
	// Эмодзи и прочая внеплоскостная пиктография — отбрасываем (BMP supplementary
	// planes начиная с U+10000). Это покрывает 🍕🥗🔥 и т.д.
	case r > 0xFFFF:
		return dropRune
	// Геометрические/символьные знаки внутри BMP, которые часто прилетают в
	// названиях блюд из старых меню (U+2600..U+27BF — Misc Symbols + Dingbats).
	// Если уже не сматчили выше — отбрасываем.
	case r >= 0x2600 && r <= 0x27BF:
		return dropRune
		// Misc Symbols and Pictographs (U+1F300..) уже отрезаны проверкой r > 0xFFFF.
	}
	return '?'
}
