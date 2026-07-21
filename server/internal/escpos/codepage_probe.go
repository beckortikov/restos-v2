package escpos

import (
	"strconv"
	"time"
)

// CodepageProbeInput — данные для страницы подбора кодовой страницы.
type CodepageProbeInput struct {
	PrinterName string
	Now         time.Time
	Cols        int
	// Candidates — какие номера таблиц пробовать. Пусто → CommonCyrillicCodepages.
	Candidates []byte
}

// CommonCyrillicCodepages — номера, под которыми кириллица встречается на
// практике.
//
//	17 — PC866 по таблице Epson, наш дефолт;
//	 7 — PC866 у части китайских клонов (Xprinter и совместимые);
//	 6 — WPC1251 (Windows-1251) там же;
//	34 — PC866 в расширенных таблицах некоторых прошивок;
//	73 — CP1251 в нумерации Epson TM-серии.
//
// Список намеренно короткий: длинная простыня из полусотни таблиц тратит метр
// бумаги и её невозможно глазами разобрать.
var CommonCyrillicCodepages = []byte{17, 7, 6, 34, 73}

// CodepageProbeLayout печатает одну и ту же русскую строку НЕСКОЛЬКИМИ
// кодовыми таблицами подряд, подписывая номер каждой.
//
// Зачем: единой нумерации в ESC/POS нет, а самотест печатает список таблиц не
// у всех моделей (у Caysn TC3680B-UP, например, в самотесте только «Default
// Codepage: GBK(255)» без самого списка). Подобрать номер иначе можно только
// перебором с пересборкой прошивки настроек — а так кассир печатает одну
// страницу, глазами находит читаемую строку и вбивает её номер в настройку
// принтера.
//
// Номер печатается ЛАТИНИЦЕЙ И ЦИФРАМИ — они читаются в любой таблице, иначе
// подпись к нечитаемой строке была бы нечитаемой сама.
func CodepageProbeLayout(in CodepageProbeInput) []byte {
	cols := in.Cols
	if cols == 0 {
		cols = Cols80
	}
	now := in.Now
	if now.IsZero() {
		now = time.Now()
	}
	candidates := in.Candidates
	if len(candidates) == 0 {
		candidates = CommonCyrillicCodepages
	}

	b := NewBuilder().Init().DisableKanji().CharsetRussia()

	b.AlignCenter().Bold(true).FontTall()
	b.CodePage(DefaultCodepage)
	b.TextLn("CODEPAGE TEST")
	b.FontNormal().Bold(false)
	b.AlignLeft()
	b.TextLn(in.PrinterName)
	b.TextLn(now.Format("02.01.2006 15:04"))
	b.Text(dashes(cols)).LF()

	// Инструкция — латиницей: она должна читаться даже если ни одна таблица
	// ниже не подошла.
	b.TextLn("Find the readable line below,")
	b.TextLn("then set its N in printer settings.")
	b.Text(dashes(cols)).LF()

	for _, cp := range candidates {
		b.CodePage(cp)
		b.Bold(true)
		// Подпись латиницей + цифрами — читается в любой таблице.
		b.TextLn("N=" + strconv.Itoa(int(cp)))
		b.Bold(false)
		b.TextLn("Проверка связи 123")
		b.TextLn("АБВГДЕ абвгде ЁЖЗИЙ")
		b.LF()
	}

	b.CodePage(DefaultCodepage)
	b.Text(dashes(cols)).LF()
	b.AlignCenter()
	b.TextLn("RestOS")
	b.Feed(3)
	b.CutWithFeed(3)
	return b.Bytes()
}
