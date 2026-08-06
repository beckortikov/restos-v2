package service

import "testing"

// TestParsePairingCode — разбор строки приглашения <baseURL>/pair/<code>.
// Whitebox (package service, не service_test): parsePairingCode неэкспортирован.
func TestParsePairingCode(t *testing.T) {
	cases := []struct {
		name        string
		in          string
		wantBaseURL string
		wantCode    string
		wantErr     bool
	}{
		{"happy https", "https://central.example.com/pair/ABCD1234", "https://central.example.com", "ABCD1234", false},
		{"happy plain ip", "http://203.0.113.5:3002/pair/K7M9QX2P", "http://203.0.113.5:3002", "K7M9QX2P", false},
		{"trailing slash on code is trimmed", "http://c:3002/pair/CODE/", "http://c:3002", "CODE", false},
		{"empty string", "", "", "", true},
		{"no /pair/ segment", "https://central.example.com", "", "", true},
		{"empty code after /pair/", "https://central.example.com/pair/", "", "", true},
		{"leading /pair/ with empty base", "/pair/CODE", "", "", true},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			base, code, err := parsePairingCode(tc.in)
			if tc.wantErr {
				if err == nil {
					t.Fatalf("parsePairingCode(%q) = %q, %q, nil — want error", tc.in, base, code)
				}
				return
			}
			if err != nil {
				t.Fatalf("parsePairingCode(%q) unexpected error: %v", tc.in, err)
			}
			if base != tc.wantBaseURL || code != tc.wantCode {
				t.Errorf("parsePairingCode(%q) = %q, %q — want %q, %q", tc.in, base, code, tc.wantBaseURL, tc.wantCode)
			}
		})
	}
}
