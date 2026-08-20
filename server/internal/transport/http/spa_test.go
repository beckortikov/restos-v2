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

// TestSPAHandler_AssetMissReturns404 — регресс-пруф: недостающий /assets/*
// файл обязан быть честным 404, НЕ index.html с 200. Иначе service worker
// (registerType: autoUpdate) прекеширует HTML под видом .js/.css как
// «успешно закешированный ассет» — навсегда, до ручной чистки Cache Storage
// у клиента (ни hard refresh, ни следующий деплой это не лечат). Вживую этим
// самым багом один плохой деплой central превратился в белый экран, который
// не снимался перезагрузкой (2026-08-20).
func TestSPAHandler_AssetMissReturns404(t *testing.T) {
	h := SPAHandler()

	req := httptest.NewRequest(http.MethodGet, "/assets/index-DOESNOTEXIST.js", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("missing asset status = %d, want 404 (got body: %q)", rr.Code, rr.Body.String())
	}
	if strings.Contains(rr.Body.String(), "<html") {
		t.Fatalf("missing asset served SPA shell instead of a real 404 — poisons SW precache")
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
