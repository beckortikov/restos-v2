package decimal

import "testing"

func TestNormalizeHalfEven(t *testing.T) {
	// Banker's rounding (half to even). shopspring/Decimal обрезает trailing zeros в
	// строковом представлении, поэтому сравниваем через Equal по нормализованному
	// значению.
	cases := []struct {
		in, want string
	}{
		{"0.12345", "0.1234"},
		{"0.12355", "0.1236"},
		{"1.00005", "1.0000"},
		{"1.00015", "1.0002"},
		{"0", "0"},
		{"-1.23456", "-1.2346"},
	}
	for _, c := range cases {
		in := MustFromString(c.in)
		want := MustFromString(c.want)
		got := Normalize(in)
		if !got.Equal(want) {
			t.Errorf("Normalize(%s) = %s, want %s", c.in, got.String(), want.String())
		}
	}
}

func TestPercent(t *testing.T) {
	amount := MustFromString("100")
	pct := MustFromString("10")
	got := Percent(amount, pct).String()
	if got != "10" && got != "10.0000" {
		t.Errorf("Percent(100, 10) = %s, want 10 or 10.0000", got)
	}
}

func TestDivRoundZeroReturnsZero(t *testing.T) {
	// v3.9.11: деление на ноль возвращает Zero, а не паникует.
	got := DivRound(MustFromString("1"), Zero)
	if !got.IsZero() {
		t.Fatalf("DivRound(1, 0) = %s, want 0", got.String())
	}
}

func TestDivRoundOr(t *testing.T) {
	fb := MustFromString("99")
	if got := DivRoundOr(MustFromString("1"), Zero, fb); !got.Equal(fb) {
		t.Fatalf("DivRoundOr(1, 0, 99) = %s, want 99", got.String())
	}
	if got := DivRoundOr(MustFromString("10"), MustFromString("2"), fb).String(); got != "5" && got != "5.0000" {
		t.Fatalf("DivRoundOr(10, 2, 99) = %s, want 5", got)
	}
}

func TestFromStringError(t *testing.T) {
	if _, err := FromString("not a number"); err == nil {
		t.Fatal("expected error")
	}
}
