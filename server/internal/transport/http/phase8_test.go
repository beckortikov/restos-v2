//go:build integration

package http_test

import (
	"encoding/json"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// TestPhase8_ShadowIngestAndStats — фронт шлёт batch, GET stats показывает
// корректные агрегаты по операциям.
func TestPhase8_ShadowIngestAndStats(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)
	_ = gdb

	// Прямой POST на shadow/reports (этот endpoint не в idempotency group →
	// header Idempotency-Key игнорируется).
	body := map[string]any{
		"app_version": "test-1.0",
		"items": []map[string]any{
			{"operation": "menu.items.list", "matched": true, "v1_latency_ms": 80, "v4_latency_ms": 5},
			{"operation": "menu.items.list", "matched": true, "v1_latency_ms": 95, "v4_latency_ms": 6},
			{"operation": "menu.items.list", "matched": true, "v1_latency_ms": 90, "v4_latency_ms": 4},
			{"operation": "orders.list", "matched": true, "v1_latency_ms": 200, "v4_latency_ms": 8},
			{"operation": "orders.list", "matched": false, "v1_latency_ms": 195, "v4_latency_ms": 7,
				"diff_size_bytes": 42, "diff_sample": "@123\nV1: ...\nV4: ..."},
		},
	}
	resp, b := f.post(t, "/api/v1/admin/shadow/reports", tok, uuid.NewString(), body)
	if resp.StatusCode != 202 {
		t.Fatalf("ingest %d: %s", resp.StatusCode, b)
	}
	var acc struct{ Accepted int }
	_ = json.Unmarshal(b, &acc)
	if acc.Accepted != 5 {
		t.Errorf("accepted = %d, want 5", acc.Accepted)
	}

	// GET stats — totals + по operations.
	statsResp, statsBody := f.get(t, "/api/v1/admin/shadow/stats", tok)
	if statsResp.StatusCode != 200 {
		t.Fatalf("stats %d", statsResp.StatusCode)
	}
	var st struct {
		Total       int     `json:"total"`
		Matched     int     `json:"matched"`
		MatchRate   float64 `json:"match_rate"`
		ByOperation []struct {
			Operation string  `json:"operation"`
			Total     int     `json:"total"`
			Matched   int     `json:"matched"`
			MatchRate float64 `json:"match_rate"`
		} `json:"by_operation"`
	}
	_ = json.Unmarshal(statsBody, &st)

	if st.Total != 5 || st.Matched != 4 {
		t.Errorf("totals: total=%d matched=%d (want 5/4)", st.Total, st.Matched)
	}
	if st.MatchRate < 0.79 || st.MatchRate > 0.81 {
		t.Errorf("match_rate = %.2f, want ~0.80", st.MatchRate)
	}
	if len(st.ByOperation) != 2 {
		t.Fatalf("by_operation: want 2 ops, got %d", len(st.ByOperation))
	}
	// "menu.items.list" — 3 OK, "orders.list" — 1 OK / 2 total (50%).
	for _, op := range st.ByOperation {
		switch op.Operation {
		case "menu.items.list":
			if op.Total != 3 || op.Matched != 3 || op.MatchRate != 1.0 {
				t.Errorf("menu op mismatch: %+v", op)
			}
		case "orders.list":
			if op.Total != 2 || op.Matched != 1 || op.MatchRate != 0.5 {
				t.Errorf("orders op mismatch: %+v", op)
			}
		}
	}
}

// TestPhase8_ShadowRecentDrifts — показывает только matched=false.
func TestPhase8_ShadowRecentDrifts(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	body := map[string]any{
		"items": []map[string]any{
			{"operation": "orders.list", "matched": false, "diff_sample": "diff-A"},
			{"operation": "orders.list", "matched": true},
			{"operation": "menu.items.list", "matched": false, "diff_sample": "diff-B"},
		},
	}
	resp, _ := f.post(t, "/api/v1/admin/shadow/reports", tok, uuid.NewString(), body)
	if resp.StatusCode != 202 {
		t.Fatal(resp.StatusCode)
	}

	driftResp, driftBody := f.get(t, "/api/v1/admin/shadow/drifts?limit=10", tok)
	if driftResp.StatusCode != 200 {
		t.Fatal(driftResp.StatusCode)
	}
	var env struct {
		Data []models.ShadowDrift `json:"data"`
	}
	_ = json.Unmarshal(driftBody, &env)
	if len(env.Data) != 2 {
		t.Errorf("want 2 drifts (only matched=false), got %d", len(env.Data))
	}
	for _, d := range env.Data {
		if d.Matched {
			t.Errorf("drift row has matched=true")
		}
	}
}

// TestPhase8_ShadowTenantIsolation — drift'ы одного ресторана не видны другому.
func TestPhase8_ShadowTenantIsolation(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Кладём один drift через текущий token (ресторан A).
	body := map[string]any{
		"items": []map[string]any{
			{"operation": "orders.list", "matched": true},
		},
	}
	respA, _ := f.post(t, "/api/v1/admin/shadow/reports", tok, uuid.NewString(), body)
	if respA.StatusCode != 202 {
		t.Fatal(respA.StatusCode)
	}

	// Ресторан B: создаём отдельную фикстуру (отдельный токен).
	// Простейший способ — отдельный httptest server (через setupE2E).
	f2 := setupE2E(t)
	tok2 := f2.login(t)
	respStats, body2 := f2.get(t, "/api/v1/admin/shadow/stats", tok2)
	if respStats.StatusCode != 200 {
		t.Fatal(respStats.StatusCode)
	}
	var st struct{ Total int }
	_ = json.Unmarshal(body2, &st)
	if st.Total != 0 {
		t.Errorf("tenant B should see 0 drifts, got %d", st.Total)
	}
}

// TestPhase8_ShadowLatencyAverages — проверяем что AVG-агрегация работает.
func TestPhase8_ShadowLatencyAverages(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	body := map[string]any{
		"items": []map[string]any{
			{"operation": "orders.list", "matched": true, "v1_latency_ms": 100, "v4_latency_ms": 10},
			{"operation": "orders.list", "matched": true, "v1_latency_ms": 200, "v4_latency_ms": 20},
		},
	}
	resp, _ := f.post(t, "/api/v1/admin/shadow/reports", tok, uuid.NewString(), body)
	if resp.StatusCode != 202 {
		t.Fatal(resp.StatusCode)
	}

	from := time.Now().Add(-1 * time.Hour).UTC().Format(time.RFC3339)
	to := time.Now().Add(1 * time.Hour).UTC().Format(time.RFC3339)
	_, b := f.get(t, "/api/v1/admin/shadow/stats?from="+from+"&to="+to, tok)
	var st struct {
		ByOperation []struct {
			Operation      string  `json:"operation"`
			AvgV1LatencyMs float64 `json:"avg_v1_latency_ms"`
			AvgV4LatencyMs float64 `json:"avg_v4_latency_ms"`
		} `json:"by_operation"`
	}
	_ = json.Unmarshal(b, &st)
	if len(st.ByOperation) != 1 {
		t.Fatalf("want 1 op, got %d", len(st.ByOperation))
	}
	op := st.ByOperation[0]
	if op.AvgV1LatencyMs != 150 || op.AvgV4LatencyMs != 15 {
		t.Errorf("avg latency mismatch: v1=%.0f (want 150), v4=%.0f (want 15)",
			op.AvgV1LatencyMs, op.AvgV4LatencyMs)
	}
}

// Suppress unused.
var _ = http.MethodPost
