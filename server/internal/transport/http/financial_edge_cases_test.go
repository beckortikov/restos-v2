//go:build integration

package http_test

import (
	"encoding/json"
	"fmt"
	"net/url"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// TestFinancialEdgeCases — критичные «денежные» edge cases:
// refund, 100% discount, reopen, semi-finished cascade, mixed-payments,
// PnL/DDS edges, bonus. Цель — найти регрессии и MISSING-функционал.
// Никаких подгонов; если число не сходится — t.Errorf MISMATCH.
func TestFinancialEdgeCases(t *testing.T) {
	// Каждый t.Run использует свой setupE2E, чтобы избежать наслоения
	// state между сценариями. Setup относительно дешёв.

	t.Run("Refund_Full_Cash", func(t *testing.T) {
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})

		mid, sid, accID, _ := bootstrapForOrder(t, f, gdb, "1000")

		// Order 1 × 100 (поставим price на 100 ad-hoc).
		gdb.Model(&models.MenuItem{}).Where("id = ?", mid).Update("price", decimal.MustFromString("100"))

		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode != 201 {
			t.Fatalf("create order %d: %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)

		// Close cash 100.
		cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
			map[string]any{"payment_method": "cash", "account_id": accID, "shift_id": sid})
		if cr.StatusCode != 200 {
			t.Fatalf("close %d: %s", cr.StatusCode, cb)
		}

		// Balance after close = 1000 + 100 = 1100.
		var accAfterClose models.FinancialAccount
		gdb.First(&accAfterClose, "id = ?", accID)
		if !accAfterClose.Balance.Equal(decimal.MustFromString("1100")) {
			t.Errorf("MISMATCH balance after close = %s, want 1100", accAfterClose.Balance.String())
		}

		// Stock после close: ingredient.qty уменьшился.
		var ingBefore models.Ingredient
		gdb.Where("restaurant_id = ?", f.rid).First(&ingBefore)
		stockBefore := ingBefore.Qty

		// Refund full.
		rr, rb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/refund", ord.ID), tok, uuid.NewString(),
			map[string]any{"reason": "клиент недоволен"})
		if rr.StatusCode != 200 {
			t.Errorf("MISSING or failing: refund returned %d: %s", rr.StatusCode, rb)
			return
		}

		// Order status = refunded, refunded_total = 100.
		var ordAfter models.Order
		gdb.First(&ordAfter, "id = ?", ord.ID)
		if ordAfter.Status == nil || *ordAfter.Status != "refunded" {
			t.Errorf("MISMATCH order status after refund = %v, want refunded", ordAfter.Status)
		}
		if !ordAfter.RefundedTotal.Equal(decimal.MustFromString("100")) {
			t.Errorf("MISMATCH refunded_total = %s, want 100", ordAfter.RefundedTotal.String())
		}

		// NEW financial_operation type=out, category=refund, amount=100.
		var refundOps []models.FinancialOperation
		gdb.Where("restaurant_id = ? AND category = ?", f.rid, "refund").Find(&refundOps)
		if len(refundOps) != 1 {
			t.Errorf("MISMATCH refund finops count = %d, want 1", len(refundOps))
		}
		if len(refundOps) == 1 && !refundOps[0].Amount.Equal(decimal.MustFromString("100")) {
			t.Errorf("MISMATCH refund amount = %s, want 100", refundOps[0].Amount.String())
		}

		// Balance: 1100 - 100 = 1000.
		var accFinal models.FinancialAccount
		gdb.First(&accFinal, "id = ?", accID)
		if !accFinal.Balance.Equal(decimal.MustFromString("1000")) {
			t.Errorf("MISMATCH balance after refund = %s, want 1000", accFinal.Balance.String())
		}

		// Stock: refund НЕ возвращает ингредиенты на склад (deliberate).
		var ingFinal models.Ingredient
		gdb.First(&ingFinal, "id = ?", ingBefore.ID)
		if !ingFinal.Qty.Equal(stockBefore) {
			t.Errorf("MISMATCH stock changed after refund: was %s, now %s (expected: refund does NOT restock)",
				stockBefore.String(), ingFinal.Qty.String())
		}
	})

	t.Run("Discount_15pct_NoApprovalGate", func(t *testing.T) {
		// Backend должен либо отклонить, либо принять с requires_approval.
		// Сейчас принимает молча — это finding.
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

		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode != 201 {
			t.Fatalf("create order %d: %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)

		cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
			map[string]any{
				"payment_method": "cash", "account_id": accID, "shift_id": sid,
				"discount_type": "percent", "discount_value": "15",
			})
		if cr.StatusCode == 200 {
			t.Errorf("MISSING: discount=15%% (>=10%%) accepted without approval gate (got 200). Body: %s", cb)
		} else {
			// 4xx — ожидаемо.
			t.Logf("OK: discount=15%% rejected with status %d", cr.StatusCode)
		}
	})

	t.Run("Discount_100pct", func(t *testing.T) {
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})

		mid, sid, accID, ingID := bootstrapForOrder(t, f, gdb, "1000")
		// Включаем tech_cards чтобы stock списался.
		on := true
		gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).Update("tech_cards_enabled", &on)
		gdb.Model(&models.MenuItem{}).Where("id = ?", mid).
			Updates(map[string]any{"price": decimal.MustFromString("100"), "cogs": decimal.MustFromString("4")})

		var ingBefore models.Ingredient
		gdb.First(&ingBefore, "id = ?", ingID)
		stockBefore := ingBefore.Qty

		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode != 201 {
			t.Fatalf("create %d: %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)

		cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
			map[string]any{
				"payment_method": "cash", "account_id": accID, "shift_id": sid,
				"discount_type": "percent", "discount_value": "100",
			})
		if cr.StatusCode != 200 {
			// Может быть отклонено approval-gate'ом (см. предыдущий кейс).
			t.Logf("close with 100%% discount returned %d: %s — likely approval gate", cr.StatusCode, cb)
			return
		}
		var closed models.Order
		_ = json.Unmarshal(cb, &closed)
		if decimal.IsNegative(closed.TotalWithService) {
			t.Errorf("MISMATCH total_with_service = %s, must be >= 0", closed.TotalWithService.String())
		}
		// total_with_service = 0 (subtotal 100 - 100 discount, без service/tip).
		if !closed.TotalWithService.IsZero() {
			t.Errorf("MISMATCH total_with_service = %s, want 0", closed.TotalWithService.String())
		}

		// Stock всё равно списан.
		var ingAfter models.Ingredient
		gdb.First(&ingAfter, "id = ?", ingID)
		if ingAfter.Qty.Equal(stockBefore) {
			t.Errorf("MISMATCH stock not deducted on 100%% discount (was %s, still %s)",
				stockBefore.String(), ingAfter.Qty.String())
		}

		// Revenue finop. Создаётся с amount=0 — это поведение.
		var ops []models.FinancialOperation
		gdb.Where("source_ref = ?", "order:"+ord.ID).Find(&ops)
		if len(ops) != 1 {
			t.Errorf("expected 1 revenue finop on 100%% discount, got %d", len(ops))
		} else if !ops[0].Amount.IsZero() {
			t.Errorf("MISMATCH revenue finop amount = %s, want 0", ops[0].Amount.String())
		}
	})

	t.Run("Reopen_DoesNotReverseFinops", func(t *testing.T) {
		// Reopen — намеренное legacy-поведение: финопы и stock_movements
		// остаются. Тест документирует это и ловит дубль revenue после
		// повторного close.
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

		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode != 201 {
			t.Fatalf("create %d: %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)

		_, _ = f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
			map[string]any{"payment_method": "cash", "account_id": accID, "shift_id": sid})

		var balAfter1 models.FinancialAccount
		gdb.First(&balAfter1, "id = ?", accID)

		// Reopen.
		rr, rb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/reopen", ord.ID), tok, uuid.NewString(), nil)
		if rr.StatusCode != 200 {
			t.Fatalf("reopen %d: %s", rr.StatusCode, rb)
		}

		var ordReopened models.Order
		gdb.First(&ordReopened, "id = ?", ord.ID)
		if ordReopened.Status == nil || *ordReopened.Status != "served" {
			t.Errorf("MISMATCH status after reopen = %v, want served", ordReopened.Status)
		}

		// Финоп НЕ должен быть удалён по текущему дизайну.
		var opsAfterReopen []models.FinancialOperation
		gdb.Where("source_ref = ?", "order:"+ord.ID).Find(&opsAfterReopen)
		if len(opsAfterReopen) != 1 {
			t.Errorf("MISSING/MISMATCH: reopen should leave finop (legacy), got %d", len(opsAfterReopen))
		}

		// Balance не уменьшается на reopen — это БАГ с точки зрения учёта,
		// но текущее поведение. Фиксируем.
		var balAfterReopen models.FinancialAccount
		gdb.First(&balAfterReopen, "id = ?", accID)
		if !balAfterReopen.Balance.Equal(balAfter1.Balance) {
			t.Errorf("MISMATCH: reopen reverted balance (was %s, now %s) — expected unchanged per current design",
				balAfter1.Balance.String(), balAfterReopen.Balance.String())
		}

		// Re-close → дубль revenue (намеренно). Если фиксят логику —
		// тест должен будет обновиться.
		cr2, cb2 := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
			map[string]any{"payment_method": "cash", "account_id": accID, "shift_id": sid})
		if cr2.StatusCode != 200 {
			t.Logf("re-close after reopen returned %d: %s", cr2.StatusCode, cb2)
		}
		var opsAfterReclose []models.FinancialOperation
		gdb.Where("source_ref = ?", "order:"+ord.ID).Find(&opsAfterReclose)
		if len(opsAfterReclose) < 1 {
			t.Errorf("MISSING revenue finop after reclose")
		}
		// Если дубль — это знаём.
		if len(opsAfterReclose) == 2 {
			t.Logf("DOCUMENTED: reopen+reclose creates duplicate revenue finop (legacy)")
		}
	})

	t.Run("SemiFinished_Cascade_NotImplemented", func(t *testing.T) {
		// Тех-карта со ссылкой на полуфабрикат → списание в каскаде до базовых
		// ингредиентов. По исходнику orders_close.go комментарий говорит:
		// «semi_finished — пропускаем в MVP». Тест документирует это.
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})

		mid, sid, accID, _ := bootstrapForOrder(t, f, gdb, "1000")
		on := true
		gdb.Model(&models.Restaurant{}).Where("id = ?", f.rid).Update("tech_cards_enabled", &on)

		// Создаём «Мука» 5kg.
		mukaName, kg := "Мука", "kg"
		muka := &models.Ingredient{
			ID: uuid.NewString(), Name: &mukaName, Unit: &kg,
			RestaurantID: &f.rid, Qty: decimal.MustFromString("5"),
		}
		if err := gdb.Create(muka).Error; err != nil {
			t.Fatal(err)
		}

		// Привяжем tech_card_line к menu_item, ссылающаяся на ingredient_id=Мука
		// (semi_finished_type_id отдельная колонка; если её нет — пропускаем
		// каскадную часть и проверяем прямую деdукцию).
		tclName := mukaName
		if err := gdb.Create(&models.TechCardLine{
			ID:           uuid.NewString(),
			MenuItemID:   &mid,
			IngredientID: &muka.ID,
			Name:         &tclName,
			Qty:          decimal.MustFromString("0.3"),
			Unit:         &kg,
			RestaurantID: &f.rid,
		}).Error; err != nil {
			t.Fatal(err)
		}

		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "2"}}})
		if r.StatusCode != 201 {
			t.Fatalf("create %d: %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)
		cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
			map[string]any{"payment_method": "cash", "account_id": accID, "shift_id": sid})
		if cr.StatusCode != 200 {
			t.Fatalf("close %d: %s", cr.StatusCode, cb)
		}

		// Прямое списание Мука: 2 × 0.3 = 0.6, qty 5 → 4.4.
		var after models.Ingredient
		gdb.First(&after, "id = ?", muka.ID)
		if !after.Qty.Equal(decimal.MustFromString("4.4")) {
			t.Errorf("MISMATCH direct ingredient deduction = %s, want 4.4 (5 - 2*0.3)", after.Qty.String())
		}
		t.Logf("DOCUMENTED MISSING: semi-finished cascade (tech_card_line -> semi_type -> ingredients) skipped in MVP (see orders_close.go:513)")
	})

	t.Run("Mixed_Payment_Overpay_Rejected", func(t *testing.T) {
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

		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode != 201 {
			t.Fatalf("create %d: %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)

		// Overpay total=100, sum=120.
		cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
			map[string]any{
				"shift_id": sid,
				"payments": []map[string]any{{"method": "cash", "amount": "120", "account_id": accID}},
			})
		if cr.StatusCode == 200 {
			t.Errorf("MISSING: overpay (sum 120 vs total 100) accepted (200). Body: %s", cb)
		} else {
			t.Logf("OK: overpay rejected status %d", cr.StatusCode)
		}
	})

	t.Run("Mixed_Payment_Underpay_Rejected", func(t *testing.T) {
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

		r2, b2 := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r2.StatusCode != 201 {
			t.Fatalf("create %d: %s", r2.StatusCode, b2)
		}
		var ord2 models.Order
		_ = json.Unmarshal(b2, &ord2)

		cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord2.ID), tok, uuid.NewString(),
			map[string]any{
				"shift_id": sid,
				"payments": []map[string]any{
					{"method": "cash", "amount": "50", "account_id": accID},
					{"method": "card", "amount": "30", "account_id": accID},
				},
			})
		if cr.StatusCode == 200 {
			t.Errorf("MISSING: underpay (sum 80 vs total 100) accepted. Body: %s", cb)
		} else {
			t.Logf("OK: underpay rejected status %d", cr.StatusCode)
		}
	})

	t.Run("Mixed_Payment_Exact_Split", func(t *testing.T) {
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})
		mid, sid, cashID, _ := bootstrapForOrder(t, f, gdb, "1000")
		// Второй счёт «Bank».
		bankID := uuid.NewString()
		bn, bt := "Bank", "bank"
		if err := gdb.Create(&models.FinancialAccount{
			ID: bankID, Name: &bn, Type: &bt, RestaurantID: &f.rid,
			Balance: decimal.MustFromString("500"),
		}).Error; err != nil {
			t.Fatal(err)
		}
		gdb.Model(&models.MenuItem{}).Where("id = ?", mid).Update("price", decimal.MustFromString("100"))

		r, b := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": mid, "qty": "1"}}})
		if r.StatusCode != 201 {
			t.Fatalf("create %d: %s", r.StatusCode, b)
		}
		var ord models.Order
		_ = json.Unmarshal(b, &ord)

		cr, cb := f.post(t, fmt.Sprintf("/api/v1/orders/%s/close", ord.ID), tok, uuid.NewString(),
			map[string]any{
				"shift_id": sid,
				"payments": []map[string]any{
					{"method": "cash", "amount": "50", "account_id": cashID},
					{"method": "card", "amount": "50", "account_id": bankID},
				},
			})
		if cr.StatusCode != 200 {
			t.Fatalf("close split %d: %s", cr.StatusCode, cb)
		}

		// Два finops по 50.
		var ops []models.FinancialOperation
		gdb.Where("source_ref = ?", "order:"+ord.ID).Find(&ops)
		if len(ops) != 2 {
			t.Errorf("MISMATCH split finops count = %d, want 2", len(ops))
		}
		var cashAfter, bankAfter models.FinancialAccount
		gdb.First(&cashAfter, "id = ?", cashID)
		gdb.First(&bankAfter, "id = ?", bankID)
		if !cashAfter.Balance.Equal(decimal.MustFromString("1050")) {
			t.Errorf("MISMATCH cash balance = %s, want 1050", cashAfter.Balance.String())
		}
		if !bankAfter.Balance.Equal(decimal.MustFromString("550")) {
			t.Errorf("MISMATCH bank balance = %s, want 550", bankAfter.Balance.String())
		}
	})

	t.Run("PnL_EmptyPeriod_AllZero", func(t *testing.T) {
		f := setupE2E(t)
		tok := f.login(t)
		// Период в будущем — нет операций.
		from := time.Now().UTC().AddDate(1, 0, 0).Format(time.RFC3339)
		to := time.Now().UTC().AddDate(1, 0, 1).Format(time.RFC3339)
		q := url.Values{}
		q.Set("from", from)
		q.Set("to", to)
		r, b := f.get(t, "/api/v1/finance/pnl?"+q.Encode(), tok)
		if r.StatusCode != 200 {
			t.Fatalf("pnl empty %d: %s", r.StatusCode, b)
		}
		var pnl struct {
			Revenue struct {
				Total decimal.Decimal `json:"total"`
			} `json:"revenue"`
			NetProfit decimal.Decimal `json:"net_profit"`
		}
		_ = json.Unmarshal(b, &pnl)
		if !pnl.Revenue.Total.IsZero() {
			t.Errorf("MISMATCH empty pnl revenue = %s, want 0", pnl.Revenue.Total.String())
		}
		if !pnl.NetProfit.IsZero() {
			t.Errorf("MISMATCH empty pnl net = %s, want 0", pnl.NetProfit.String())
		}
	})

	t.Run("Bonus_ManualFinop", func(t *testing.T) {
		// Бонус — ручной finop type=out category=bonus.
		f := setupE2E(t)
		tok := f.login(t)
		gdb, _ := db.Open(testDSN())
		t.Cleanup(func() {
			if sqlDB, err := gdb.DB(); err == nil {
				_ = sqlDB.Close()
			}
		})
		_, _, accID, _ := bootstrapForOrder(t, f, gdb, "1000")

		r, b := f.post(t, "/api/v1/finance/operations", tok, uuid.NewString(),
			map[string]any{
				"type": "out", "amount": "75", "category": "bonus",
				"account_id": accID, "activity": "operational",
				"description": "Бонус повару",
			})
		if r.StatusCode != 201 {
			t.Fatalf("create bonus %d: %s", r.StatusCode, b)
		}
		var acc models.FinancialAccount
		gdb.First(&acc, "id = ?", accID)
		if !acc.Balance.Equal(decimal.MustFromString("925")) {
			t.Errorf("MISMATCH balance after bonus = %s, want 925", acc.Balance.String())
		}
	})
}

// bootstrapForOrder — мини-сетап: меню (из setupE2E), ingredient,
// tech_card_line, открытая смена, cash-счёт с указанным балансом.
// Возвращает: menu_item_id, shift_id, account_id, ingredient_id.
// Параметр gdb — *gorm.DB, типа interface{} только чтобы не таскать import
// gorm в сигнатуру (передающий код всё равно держит *gorm.DB живым).
func bootstrapForOrder(t *testing.T, f *e2eFixture, _ interface{}, cashBalance string) (string, string, string, string) {
	t.Helper()
	gdbReal, _ := db.Open(testDSN())
	t.Cleanup(func() {
		if sqlDB, err := gdbReal.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	var mi models.MenuItem
	if err := gdbReal.Where("restaurant_id = ?", f.rid).First(&mi).Error; err != nil {
		t.Fatal(err)
	}
	// v2.0.90 — включаем tech_cards+strict, чтобы backend stock-gate работал.
	// Большинство сценариев ниже создают tech_card_line + ingredient через
	// эту хелперу, и ожидают, что заказ создаётся (ingredient.qty=10 хватит).
	// Тесты, которые проверяют shortage, переопределяют qty=0 ниже.
	on := true
	gdbReal.Model(&models.Restaurant{}).Where("id = ?", f.rid).
		Updates(map[string]any{"tech_cards_enabled": &on, "enforce_stock_check": &on})
	ingName, ingUnit := "Rice-"+uuid.NewString()[:8], "kg"
	ing := &models.Ingredient{
		ID: uuid.NewString(), Name: &ingName, Unit: &ingUnit, RestaurantID: &f.rid,
		Qty: decimal.MustFromString("10"),
	}
	if err := gdbReal.Create(ing).Error; err != nil {
		t.Fatal(err)
	}
	tclName := ingName
	if err := gdbReal.Create(&models.TechCardLine{
		ID:           uuid.NewString(),
		MenuItemID:   &mi.ID,
		IngredientID: &ing.ID,
		Name:         &tclName,
		Qty:          decimal.MustFromString("0.2"),
		Unit:         &ingUnit,
		RestaurantID: &f.rid,
	}).Error; err != nil {
		t.Fatal(err)
	}
	accID := uuid.NewString()
	accName, accType := "Cash-"+uuid.NewString()[:6], "cash"
	if err := gdbReal.Create(&models.FinancialAccount{
		ID: accID, Name: &accName, Type: &accType,
		RestaurantID: &f.rid, Balance: decimal.MustFromString(cashBalance),
	}).Error; err != nil {
		t.Fatal(err)
	}
	tok := f.login(t)
	r, b := f.post(t, "/api/v1/shifts", tok, uuid.NewString(),
		map[string]any{"opening_balance": "0", "account_id": accID})
	if r.StatusCode != 201 {
		t.Fatalf("open shift %d: %s", r.StatusCode, b)
	}
	var sh models.CashShift
	_ = json.Unmarshal(b, &sh)
	return mi.ID, sh.ID, accID, ing.ID
}
