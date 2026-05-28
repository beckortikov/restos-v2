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
	got := EncodeCP866("€")
	if len(got) != 1 || got[0] != '?' {
		t.Errorf("unknown should be '?', got %x", got)
	}
}
