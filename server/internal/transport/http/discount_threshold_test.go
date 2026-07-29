//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"net/http"
	"testing"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestDiscountApprovalThreshold_Configurable — порог одобрения скидки
// настраивается на ресторане (discount_approval_threshold), а не захардкожен 10%.
//
// Ablation: при пороге 20% скидка 15% проходит БЕЗ одобрения. Со старым
// поведением (жёсткие 10%) 15% требовала бы одобрения — так что успех этого
// кейса доказывает, что порог реально читается из ресторана.
func TestDiscountApprovalThreshold_Configurable(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})

	mid, sid, accID, _ := bootstrapForOrder(t, f, gdb, "1000")
	gdb.Model(&models.MenuItem{}).Where("id = ?", mid).Update("price", decimal.MustFromString("100"))

	// Порог ресторана = 20%.
	if err := gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).
		Update("discount_approval_threshold", decimal.MustFromString("20")).Error; err != nil {
		t.Fatal(err)
	}

	// Менеджер-одобряющий.
	mgrName, mgrRole := "Менеджер", "manager"
	mgr := &models.User{ID: uuid.NewString(), Name: &mgrName, Role: &mgrRole, RestaurantID: &f.rid}
	if err := gdb.Create(mgr).Error; err != nil {
		t.Fatal(err)
	}

	newOrder := func() string {
		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode != http.StatusCreated {
			t.Fatalf("create order: %d %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)
		return ord.ID
	}
	closeBody := func(pct string, approvedBy *string) map[string]any {
		body := map[string]any{
			"payment_method": "cash", "account_id": accID, "shift_id": sid,
			"discount_type": "percent", "discount_value": pct,
		}
		if approvedBy != nil {
			body["approved_by"] = *approvedBy
		}
		return body
	}

	// ─── 15% при пороге 20% — БЕЗ одобрения проходит (ablation) ──────────────
	oid := newOrder()
	r, b := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), closeBody("15", nil))
	if r.StatusCode != http.StatusOK {
		t.Fatalf("скидка 15%% при пороге 20%% должна пройти без одобрения, получили %d: %s", r.StatusCode, b)
	}

	// ─── 25% при пороге 20% — БЕЗ одобрения отбивается ───────────────────────
	oid = newOrder()
	r, b = f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), closeBody("25", nil))
	if r.StatusCode == http.StatusOK {
		t.Fatalf("скидка 25%% при пороге 20%% без одобрения должна отбиться, получили 200: %s", b)
	}
	var env struct {
		Code string `json:"code"`
	}
	_ = json.Unmarshal(b, &env)
	if env.Code != "DISCOUNT_REQUIRES_APPROVAL" {
		t.Errorf("код ошибки = %q, want DISCOUNT_REQUIRES_APPROVAL. body: %s", env.Code, b)
	}

	// ─── 25% с одобрением менеджера — проходит ───────────────────────────────
	oid = newOrder()
	r, b = f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", oid), tok, uuid.NewString(), closeBody("25", &mgr.ID))
	if r.StatusCode != http.StatusOK {
		t.Fatalf("скидка 25%% с одобрением менеджера должна пройти, получили %d: %s", r.StatusCode, b)
	}
	var closed models.Order
	_ = json.Unmarshal(b, &closed)
	if closed.DiscountApprovedBy == nil || *closed.DiscountApprovedBy != mgr.ID {
		t.Errorf("discount_approved_by = %v, want %s", closed.DiscountApprovedBy, mgr.ID)
	}
}
