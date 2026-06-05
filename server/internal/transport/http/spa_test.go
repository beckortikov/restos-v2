package http

import (
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

func TestSPAHandler_ServesIndex(t *testing.T) {
	h := SPAHandler()

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("/ status = %d, want 200", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "<html") {
		t.Fatalf("/ body does not look like HTML: %q", rr.Body.String()[:min(80, len(rr.Body.String()))])
	}
}

func TestSPAHandler_FallbackToIndex(t *testing.T) {
	h := SPAHandler()

	// Любой произвольный путь → SPA fallback (index.html).
	req := httptest.NewRequest(http.MethodGet, "/operations/pos", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusOK {
		t.Fatalf("/operations/pos status = %d, want 200 (SPA fallback)", rr.Code)
	}
	if !strings.Contains(rr.Body.String(), "<html") {
		t.Fatalf("fallback body is not HTML")
	}
}

func TestSPAHandler_GuardsAPIPaths(t *testing.T) {
	h := SPAHandler()

	cases := []string{"/api/v1/orders", "/sse", "/healthz", "/readyz", "/docs/index.html"}
	for _, p := range cases {
		req := httptest.NewRequest(http.MethodGet, p, nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		if rr.Code != http.StatusNotFound {
			t.Errorf("%s: status = %d, want 404 (must not be shadowed by SPA)", p, rr.Code)
		}
	}
}

