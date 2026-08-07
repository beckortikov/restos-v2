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
	gdb.Exec("DELETE FROM sync_settings")

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

	// activeConfig теперь читает central_url/token/enabled из sync_settings
	// на каждый тик (ADR-003, продолжение), а не из аргументов конструктора.
	url := srv.URL
	if err := gdb.Create(&models.SyncSettings{ID: 1, Enabled: true, CentralURL: &url, IntervalSec: 30}).Error; err != nil {
		t.Fatalf("seed sync_settings: %v", err)
	}
	p := synclog.NewPusher(repo.New(gdb))

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

// TestPusher_ReflectsSettingsChangeWithoutRestart — регресс-пруф ADR-003
// «продолжение»: ОДИН и тот же *Pusher (как одна долгоживущая горутина
// процесса) должен подхватывать изменения sync_settings БЕЗ пересоздания —
// это и убирает требование перезапускать приложение после вставки кода
// приглашения / включения синхронизации в UI.
func TestPusher_ReflectsSettingsChangeWithoutRestart(t *testing.T) {
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
	gdb.Exec("DELETE FROM sync_settings")

	if err := gdb.Create(&models.SyncLog{
		ID: uuid.NewString(), Entity: "stock_transfers", RowID: uuid.NewString(),
		Op: "insert", Payload: datatypes.JSON(`{"id":"x"}`),
	}).Error; err != nil {
		t.Fatal(err)
	}

	var received int
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
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

	p := synclog.NewPusher(repo.New(gdb))

	// ─── Без строки sync_settings вообще — тихо ничего не делает ─────────
	n0, err := p.PushOnce(t.Context())
	if err != nil {
		t.Fatalf("PushOnce (unconfigured): %v", err)
	}
	if n0 != 0 {
		t.Errorf("pushed = %d before sync configured, want 0", n0)
	}
	if synclog.Enabled() {
		t.Error("synclog.Enabled() = true before sync configured")
	}

	// ─── Имитация JoinNetwork: код приглашения только что применился ─────
	url := srv.URL
	if err := gdb.Create(&models.SyncSettings{ID: 1, Enabled: true, CentralURL: &url, IntervalSec: 30}).Error; err != nil {
		t.Fatalf("simulate JoinNetwork write: %v", err)
	}

	// ─── ТОТ ЖЕ экземпляр Pusher, без пересоздания — должен увидеть новый
	// central_url и разослать очередь ─────────────────────────────────────
	n1, err := p.PushOnce(t.Context())
	if err != nil {
		t.Fatalf("PushOnce (after live config change): %v", err)
	}
	if n1 != 1 {
		t.Errorf("pushed = %d after config change without recreating Pusher, want 1", n1)
	}
	if received != 1 {
		t.Errorf("central received = %d entries, want 1", received)
	}
	if !synclog.Enabled() {
		t.Error("synclog.Enabled() = false after sync configured — recorder would silently drop new deltas")
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
