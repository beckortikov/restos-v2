//go:build integration

package synclog_test

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/synclog"
)

func dsn() string {
	if v := os.Getenv("RESTOS_TEST_DSN"); v != "" {
		return v
	}
	return "host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable"
}

// TestPusher_PushOnce — пушер читает неотправленные sync_log, POST'ит на
// центральный узел и помечает synced_at (ADR-003, Фаза 2).
func TestPusher_PushOnce(t *testing.T) {
	gdb, err := db.Open(dsn())
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
	gdb.Exec("DELETE FROM sync_log")

	// Две неотправленные дельты.
	acc := uuid.NewString()
	for i := 0; i < 2; i++ {
		if err := gdb.Create(&models.SyncLog{
			ID: uuid.NewString(), Entity: "stock_transfers", RowID: uuid.NewString(),
			Op: "insert", AccountID: &acc, Payload: datatypes.JSON(`{"id":"x"}`),
		}).Error; err != nil {
			t.Fatal(err)
		}
	}

	// Стаб центрального узла: ловит батч, отвечает 200.
	var received int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/api/v1/sync/ingest" {
			w.WriteHeader(404)
			return
		}
		var body struct {
			Entries []map[string]any `json:"entries"`
		}
		b, _ := io.ReadAll(r.Body)
		_ = json.Unmarshal(b, &body)
		received = len(body.Entries)
		w.Header().Set("Content-Type", "application/json")
		_, _ = w.Write([]byte(`{"applied":` + itoa(received) + `,"skipped":0}`))
	}))
	defer srv.Close()

	p := synclog.NewPusher(repo.New(gdb), srv.URL, "")

	// ─── Первый пуш ──────────────────────────────────────────────────────
	n, err := p.PushOnce(t.Context())
	if err != nil {
		t.Fatalf("PushOnce: %v", err)
	}
	if n != 2 {
		t.Errorf("pushed = %d, want 2", n)
	}
	if received != 2 {
		t.Errorf("central received = %d entries, want 2", received)
	}
	var unsynced int64
	gdb.Model(&models.SyncLog{}).Where("synced_at IS NULL").Count(&unsynced)
	if unsynced != 0 {
		t.Errorf("unsynced after push = %d, want 0", unsynced)
	}

	// ─── Второй пуш — очередь пуста ──────────────────────────────────────
	n2, err := p.PushOnce(t.Context())
	if err != nil {
		t.Fatalf("PushOnce (empty): %v", err)
	}
	if n2 != 0 {
		t.Errorf("second push = %d, want 0", n2)
	}
}

func itoa(n int) string {
	if n == 0 {
		return "0"
	}
	var b []byte
	for n > 0 {
		b = append([]byte{byte('0' + n%10)}, b...)
		n /= 10
	}
	return string(b)
}
