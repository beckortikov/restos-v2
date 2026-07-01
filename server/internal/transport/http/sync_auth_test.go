//go:build integration

package http_test

import (
	"bytes"
	"io"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/restos/restos-v4/server/internal/db"
	httpx "github.com/restos/restos-v4/server/internal/transport/http"
)

// TestSyncAuth — межузловой auth /sync/* по общему секрету сети (ADR-003 Ф3):
// верный токен → 200, неверный/пустой → 401.
func TestSyncAuth(t *testing.T) {
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	const secret = "network-shared-secret"
	srv := httptest.NewServer(httpx.NewRouter(httpx.Deps{
		DB:        gdb,
		Build:     httpx.BuildInfo{Version: "test"},
		SyncToken: secret,
	}))
	t.Cleanup(srv.Close)

	post := func(token string) int {
		req, _ := http.NewRequest("POST", srv.URL+"/api/v1/sync/ingest", bytes.NewReader([]byte(`{"entries":[]}`)))
		req.Header.Set("Content-Type", "application/json")
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		resp, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer resp.Body.Close()
		_, _ = io.Copy(io.Discard, resp.Body)
		return resp.StatusCode
	}

	if code := post(secret); code != 200 {
		t.Errorf("correct token: got %d, want 200", code)
	}
	if code := post("wrong"); code != 401 {
		t.Errorf("wrong token: got %d, want 401", code)
	}
	if code := post(""); code != 401 {
		t.Errorf("no token: got %d, want 401", code)
	}
}

// TestSyncAuth_DisabledNode — узел без SyncToken закрывает /sync/* (401).
func TestSyncAuth_DisabledNode(t *testing.T) {
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	srv := httptest.NewServer(httpx.NewRouter(httpx.Deps{DB: gdb, Build: httpx.BuildInfo{Version: "test"}}))
	t.Cleanup(srv.Close)

	req, _ := http.NewRequest("POST", srv.URL+"/api/v1/sync/ingest", bytes.NewReader([]byte(`{"entries":[]}`)))
	req.Header.Set("Authorization", "Bearer anything")
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	if resp.StatusCode != 401 {
		t.Errorf("node without sync token: got %d, want 401", resp.StatusCode)
	}
}
