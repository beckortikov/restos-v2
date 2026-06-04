package printer

import "testing"

// TestNormalizeTCPAddr — кассир может ввести только IP без порта.
// Должны автодополнять :9100 (стандартный ESC/POS-порт), но не трогать
// уже валидный host:port и IPv6-литералы в скобках.
func TestNormalizeTCPAddr(t *testing.T) {
	cases := []struct {
		in, want string
	}{
		{"192.168.1.50", "192.168.1.50:9100"},
		{"192.168.1.50:9100", "192.168.1.50:9100"},
		{"192.168.1.50:9101", "192.168.1.50:9101"},
		{"printer.local", "printer.local:9100"},
		{"printer.local:9100", "printer.local:9100"},
		{"  192.168.1.50  ", "192.168.1.50:9100"},
		{"[::1]:9100", "[::1]:9100"},
		// Голый ":9100" — порт без host — оставляем как есть, валидный split.
		{":9100", ":9100"},
		{"", ""},
	}
	for _, tc := range cases {
		got := normalizeTCPAddr(tc.in)
		if got != tc.want {
			t.Errorf("normalizeTCPAddr(%q) = %q, want %q", tc.in, got, tc.want)
		}
	}
}
