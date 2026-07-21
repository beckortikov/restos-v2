package escpos

import (
	"strings"
	"testing"
)

// TestWrapRunnerItem — перенос названия блюда при двойной ширине.
//
// При 16 колонках почти любое реальное название переносится, поэтому важно,
// ЧТО именно оказывается на первой строке и как выглядит продолжение.
func TestWrapRunnerItem(t *testing.T) {
	const w = ColsRunnerWide // 16

	cases := []struct {
		name  string
		qty   string
		dish  string
		want  []string
		about string
	}{
		{
			name:  "короткое имя в одну строку",
			qty:   "x2",
			dish:  "Фри",
			want:  []string{"x2 Фри"},
			about: "переносить нечего",
		},
		{
			name: "длинное имя переносится по словам",
			qty:  "x1",
			dish: "Пицца Цезарь XL",
			// «x1 » (3) + 13 доступных: «Пицца Цезарь» = 12, «XL» уходит вниз.
			want:  []string{"x1 Пицца Цезарь", "   XL"},
			about: "продолжение выравнено под название",
		},
		{
			name:  "три слова — две строки",
			qty:   "x1",
			dish:  "Курутоб 1 порция",
			want:  []string{"x1 Курутоб 1", "   порция"},
			about: "слова не рвутся посередине",
		},
		{
			name: "слово длиннее строки режется",
			qty:  "x1",
			dish: "Сверхдлинноеназваниеблюда",
			want: []string{"x1 Сверхдлинноен", "   азваниеблюда"},
			// Иначе принтер обрежет его сам в произвольном месте.
			about: "режем по границе колонок",
		},
		{
			name:  "весовая позиция",
			qty:   "300г",
			dish:  "Плов",
			want:  []string{"300г Плов"},
			about: "количество может быть не только «xN»",
		},
	}

	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			got := wrapRunnerItem(c.qty, c.dish, w)
			if strings.Join(got, "|") != strings.Join(c.want, "|") {
				t.Fatalf("%s\n got: %q\nwant: %q", c.about, got, c.want)
			}
			for i, line := range got {
				if n := visibleRuneCount(line); n > w {
					t.Fatalf("строка %d длиной %d > %d колонок: %q", i, n, w, line)
				}
			}
		})
	}
}

// TestWrapRunnerItem_QtyFirst — количество обязано быть в начале первой строки.
//
// Если положить его в хвост, при переносе оно осталось бы одиноко висеть на
// последней строке — повар считает порции первым делом, и число не должно
// теряться.
func TestWrapRunnerItem_QtyFirst(t *testing.T) {
	lines := wrapRunnerItem("x3", "Шашлык из говядины по-домашнему", ColsRunnerWide)
	if len(lines) < 2 {
		t.Fatalf("ожидали перенос, получили одну строку: %q", lines)
	}
	if !strings.HasPrefix(lines[0], "x3 ") {
		t.Fatalf("количество не в начале первой строки: %q", lines[0])
	}
}
