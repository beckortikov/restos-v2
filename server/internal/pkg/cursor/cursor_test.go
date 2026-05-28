package cursor

import (
	"testing"
	"time"
)

func TestEncodeDecodeRoundtrip(t *testing.T) {
	now := time.Date(2026, 5, 25, 12, 34, 56, 789000000, time.UTC)
	tok := Token{Time: now, ID: "abc-123"}
	s := Encode(tok)
	if s == "" {
		t.Fatal("empty encoded")
	}
	back, err := Decode(s)
	if err != nil {
		t.Fatal(err)
	}
	if !back.Time.Equal(tok.Time) || back.ID != tok.ID {
		t.Errorf("roundtrip mismatch: got %+v want %+v", back, tok)
	}
}

func TestDecodeEmpty(t *testing.T) {
	tok, err := Decode("")
	if err != nil {
		t.Fatal(err)
	}
	if !tok.Time.IsZero() || tok.ID != "" {
		t.Errorf("empty should be zero, got %+v", tok)
	}
}

func TestDecodeBadInput(t *testing.T) {
	if _, err := Decode("!!!not base64!!!"); err == nil {
		t.Fatal("expected error on bad base64")
	}
}

func TestNormalizeLimit(t *testing.T) {
	cases := []struct{ in, want int }{
		{0, DefaultLimit}, {-5, DefaultLimit},
		{1, 1}, {50, 50},
		{MaxLimit, MaxLimit}, {MaxLimit + 100, MaxLimit},
	}
	for _, c := range cases {
		if got := NormalizeLimit(c.in); got != c.want {
			t.Errorf("NormalizeLimit(%d)=%d want %d", c.in, got, c.want)
		}
	}
}

func TestNext(t *testing.T) {
	type row struct {
		ID string
		T  time.Time
	}
	now := time.Now()
	rows := []row{
		{"a", now}, {"b", now.Add(-time.Second)}, {"c", now.Add(-2 * time.Second)},
	}
	key := func(r row) Token { return Token{Time: r.T, ID: r.ID} }

	// limit==len → нет следующей
	trim, next := Next(rows, 3, key)
	if next != "" || len(trim) != 3 {
		t.Errorf("no next expected, got next=%q trim=%d", next, len(trim))
	}

	// limit < len → есть следующая
	trim, next = Next(rows, 2, key)
	if next == "" || len(trim) != 2 {
		t.Errorf("next expected, got next=%q trim=%d", next, len(trim))
	}
}
