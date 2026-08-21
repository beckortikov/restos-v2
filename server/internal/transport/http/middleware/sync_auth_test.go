//go:build integration

package middleware_test

import (
	"net/http"
	"net/http/httptest"
	"os"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/middleware"
)

func dsn() string {
	if v := os.Getenv("RESTOS_TEST_DSN"); v != "" {
		return v
	}
	return "host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable"
}

// TestSyncAuth_PerBranchTokens — Фаза Г: у каждого филиала свой sync-секрет.
//
// Ради чего это сделано: пока секрет был ОДИН на всю сеть, central не мог
// отличить узлы друг от друга — и отключение филиала (Фаза У) убирало его из
// отчётов, но доступ не отзывало, о чём приходилось честно писать в интерфейсе.
// Теперь отключённый филиал получает отказ. При этом кассы, подключённые до
// этой фазы, знают только общий секрет — ломать их нельзя, поэтому он
// продолжает приниматься (легаси-путь).
func TestSyncAuth_PerBranchTokens(t *testing.T) {
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
	gdb.Exec("DELETE FROM restaurants")
	gdb.Exec("DELETE FROM company_accounts")

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})

	branchToken := "branch-secret-abc"
	hash := service.HashSyncToken(branchToken)
	branchID := uuid.NewString()
	ot := "outlet"
	gdb.Create(&models.Restaurant{
		ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot, SyncTokenHash: &hash,
	})

	const shared = "shared-network-secret"
	var sawCaller string
	h := middleware.SyncAuth(gdb, shared)(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		sawCaller, _ = middleware.SyncCallerID(r.Context())
		w.WriteHeader(http.StatusOK)
	}))

	call := func(token string) (int, string) {
		sawCaller = ""
		req := httptest.NewRequest(http.MethodGet, "/api/v1/sync/pull", nil)
		if token != "" {
			req.Header.Set("Authorization", "Bearer "+token)
		}
		rr := httptest.NewRecorder()
		h.ServeHTTP(rr, req)
		return rr.Code, sawCaller
	}

	// ─── Персональный токен: пускает И опознаёт узел ──────────────────────
	if code, caller := call(branchToken); code != http.StatusOK {
		t.Errorf("персональный токен: %d, want 200", code)
	} else if caller != branchID {
		t.Errorf("филиал не опознан: caller=%q, want %s", caller, branchID)
	}

	// ─── Общий секрет: пускает (легаси), но узел НЕ опознан ───────────────
	if code, caller := call(shared); code != http.StatusOK {
		t.Errorf("общий секрет: %d, want 200 — кассы старых версий знают только его", code)
	} else if caller != "" {
		t.Errorf("общий секрет не должен опознавать узел, а вернул %q", caller)
	}

	// ─── Мусор и пустой — отказ ───────────────────────────────────────────
	if code, _ := call("nonsense"); code != http.StatusUnauthorized {
		t.Errorf("чужой токен: %d, want 401", code)
	}
	if code, _ := call(""); code != http.StatusUnauthorized {
		t.Errorf("без токена: %d, want 401", code)
	}

	// ─── ГЛАВНОЕ: отключение филиала отзывает доступ ──────────────────────
	// DetachBranch обнуляет account_id; до Фазы Г это ничего не меняло для
	// пушей — филиал продолжал слать данные с общим секретом.
	gdb.Model(&models.Restaurant{}).Where("id = ?", branchID).Update("account_id", nil)
	if code, _ := call(branchToken); code != http.StatusUnauthorized {
		t.Errorf("отключённый филиал: %d, want 401 — отключение обязано отзывать доступ", code)
	}

	// ─── Перевыпуск токена обесценивает старый ────────────────────────────
	gdb.Model(&models.Restaurant{}).Where("id = ?", branchID).
		Updates(map[string]any{"account_id": accountID, "sync_token_hash": service.HashSyncToken("new-secret")})
	if code, _ := call(branchToken); code != http.StatusUnauthorized {
		t.Errorf("старый токен после перевыпуска: %d, want 401", code)
	}
	if code, caller := call("new-secret"); code != http.StatusOK || caller != branchID {
		t.Errorf("новый токен: %d caller=%q, want 200/%s", code, caller, branchID)
	}
}

// TestSyncAuth_NoSharedTokenConfigured — узел без общего секрета принимает
// ТОЛЬКО персональные токены филиалов; всё остальное закрыто.
func TestSyncAuth_NoSharedTokenConfigured(t *testing.T) {
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
	gdb.Exec("DELETE FROM restaurants")

	h := middleware.SyncAuth(gdb, "")(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(http.StatusOK)
	}))
	req := httptest.NewRequest(http.MethodGet, "/api/v1/sync/pull", nil)
	req.Header.Set("Authorization", "Bearer anything")
	rr := httptest.NewRecorder()
	h.ServeHTTP(rr, req)
	if rr.Code != http.StatusUnauthorized {
		t.Errorf("узел без секрета: %d, want 401", rr.Code)
	}
}
