package http

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"testing"
)

// Шаблоны импорта обязаны отдаваться валидным .xlsx (ZIP — сигнатура "PK"),
// а не SPA index.html. Регрессия: при сборке без embed-spa /docs/* проваливался
// в SPA-fallback и возвращал HTML → Excel «формат или расширение недопустимы».
func TestDocsHandler_ServesValidXLSX(t *testing.T) {
	h := DocsHandler()

	for _, name := range []string{"шаблон-техкарты.xlsx", "шаблон-карта-зала.xlsx"} {
		req := httptest.NewRequest(http.MethodGet, "/docs/"+name, nil)
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)

		if rr.Code != http.StatusOK {
			t.Fatalf("%s: status = %d, want 200", name, rr.Code)
		}
		body := rr.Body.Bytes()
		// XLSX = ZIP-архив, начинается с "PK\x03\x04".
		if !bytes.HasPrefix(body, []byte("PK\x03\x04")) {
			t.Fatalf("%s: body is not a ZIP/XLSX (head=%x) — likely HTML fallback", name, body[:min(8, len(body))])
		}
		if ct := rr.Header().Get("Content-Type"); ct == "text/html; charset=utf-8" {
			t.Fatalf("%s: Content-Type = %q, must not be HTML", name, ct)
		}
	}
}

// Отсутствующий шаблон — честный 404, НЕ SPA index.html. Иначе фронт сохранит
// HTML под именем *.xlsx.
func TestDocsHandler_MissingReturns404(t *testing.T) {
	h := DocsHandler()

	req := httptest.NewRequest(http.MethodGet, "/docs/нет-такого.xlsx", nil)
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)

	if rr.Code != http.StatusNotFound {
		t.Fatalf("missing template: status = %d, want 404", rr.Code)
	}
}
