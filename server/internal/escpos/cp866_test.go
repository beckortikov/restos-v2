package escpos

import (
	"bytes"
	"testing"
)

func TestEncodeCP866_ASCII(t *testing.T) {
	got := EncodeCP866("Hello 123")
	want := []byte("Hello 123")
	if !bytes.Equal(got, want) {
		t.Errorf("ASCII passthrough: got %v want %v", got, want)
	}
}

func TestEncodeCP866_Cyrillic(t *testing.T) {
	cases := map[string][]byte{
		"А":      {0x80},
		"Я":      {0x9F},
		"а":      {0xA0},
		"п":      {0xAF},
		"р":      {0xE0},
		"я":      {0xEF},
		"Ё":      {0xF0},
		"ё":      {0xF1},
		"Привет": {0x8F, 0xE0, 0xA8, 0xA2, 0xA5, 0xE2},
	}
	for s, want := range cases {
		got := EncodeCP866(s)
		if !bytes.Equal(got, want) {
			t.Errorf("EncodeCP866(%q): got %x want %x", s, got, want)
		}
	}
}

func TestEncodeCP866_BoxDrawing(t *testing.T) {
	got := EncodeCP866("─│")
	want := []byte{0xC4, 0xB3}
	if !bytes.Equal(got, want) {
		t.Errorf("box: got %x want %x", got, want)
	}
}

func TestEncodeCP866_Unsupported(t *testing.T) {
	// Полностью неизвестный символ (например, китайский иероглиф в BMP)
	// который не попал ни в один fallback — отдаст '?'.
	got := EncodeCP866("中")
	if len(got) != 1 || got[0] != '?' {
		t.Errorf("unknown should be '?', got %x", got)
	}
}

// TestEncodeCP866_Transliterations проверяет ASCII-fallback'и для типографских
// символов, которые иначе печатались бы как '?'. Соответствует CP866_MAP в
// ../restos/lib/print-service.ts.
func TestEncodeCP866_Transliterations(t *testing.T) {
	cases := []struct {
		in   string
		want []byte
	}{
		// em-dash, en-dash, minus sign → '-'
		{"a—b", []byte("a-b")},
		{"a–b", []byte("a-b")},
		{"a−b", []byte("a-b")},
		// guillemets / curly double quotes → '"'
		{"«Цезарь»", append(append([]byte{'"'}, EncodeCP866("Цезарь")...), '"')},
		{"“hi”", []byte(`"hi"`)},
		{"„hi“", []byte(`"hi"`)},
		// curly single quotes → "'"
		{"don’t", []byte("don't")},
		{"it‘s", []byte("it's")},
		// ellipsis → '.'
		{"wait…", []byte("wait.")},
		// multiplication × → 'x'
		{"Кофе × 2", append(append(EncodeCP866("Кофе"), ' ', 'x', ' '), '2')},
		// arrows
		{"a→b", []byte("a>b")},
		{"a←b", []byte("a<b")},
		// check marks
		{"✓", []byte("+")},
		{"✗", []byte("x")},
		// star → '*'
		{"★", []byte("*")},
		// NBSP / narrow / thin → regular space
		{"A B", []byte("A B")},
		{"A B", []byte("A B")},
		{"A B", []byte("A B")},
		// zero-width — отбрасываются полностью
		{"a​b", []byte("ab")},
		{"a‌b", []byte("ab")},
		{"a‍b", []byte("ab")},
		{"a\ufeffb", []byte("ab")},
		// emoji — отбрасываются (rune > 0xFFFF)
		{"🍕 Pizza", []byte(" Pizza")},
		{"🔥🥗 hot", []byte(" hot")},
		// Misc symbols (U+2600..U+27BF) — отбрасываются (если не сматчили выше)
		{"a☀b", []byte("ab")},
	}
	for _, tc := range cases {
		got := EncodeCP866(tc.in)
		if !bytes.Equal(got, tc.want) {
			t.Errorf("EncodeCP866(%q): got %x want %x", tc.in, got, tc.want)
		}
	}
}

// TestEncodeCP866_NoQuestionMarkLeakage — гарантирует, что в самых частых
// «грязных» строках из меню больше не появляется '?'.
func TestEncodeCP866_NoQuestionMarkLeakage(t *testing.T) {
	dirty := []string{
		"Цезарь — салат с курицей",
		"«Бизнес-ланч»",
		"Кофе × 2",
		"Готово ✓",
		"🍕 Пицца Маргарита",
		"don’t forget…",
	}
	for _, s := range dirty {
		got := EncodeCP866(s)
		if bytes.ContainsRune(got, '?') {
			t.Errorf("unexpected '?' in encoding of %q: %x", s, got)
		}
	}
}
