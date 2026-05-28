package http

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

// Smoke-тест: /healthz отвечает 200 без БД.
// /readyz без БД даёт 503 — здесь не проверяем, чтобы не тащить sqlmock в Phase 0.
func TestHealthz(t *testing.T) {
	r := NewRouter(Deps{Build: BuildInfo{Version: "test", Commit: "abc", BuildTime: "now"}})
	req := httptest.NewRequest(http.MethodGet, "/healthz", nil)
	rec := httptest.NewRecorder()

	r.ServeHTTP(rec, req)

	if rec.Code != http.StatusOK {
		t.Fatalf("want 200, got %d, body=%s", rec.Code, rec.Body.String())
	}
	if ct := rec.Header().Get("Content-Type"); ct == "" {
		t.Fatalf("missing Content-Type")
	}
}
