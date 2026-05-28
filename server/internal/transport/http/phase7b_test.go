//go:build integration

package http_test

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/xuri/excelize/v2"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/license"
)

// ─── P&L ───────────────────────────────────────────────────────────────────

func TestPhase7b_PnLBasic(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Создаём + закрываем 2 заказа (revenue 50 каждый).
	for i := 0; i < 2; i++ {
		resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{
				{"menu_item_id": menuItemID, "qty": "1"},
				{"menu_item_id": menuItemID, "qty": "1"},
			}})
		if resp.StatusCode != 201 {
			t.Fatalf("create %d: %s", resp.StatusCode, body)
		}
		var o models.Order
		_ = json.Unmarshal(body, &o)
		closePath := fmt.Sprintf("/api/v1/orders/%s/close", o.ID)
		respC, _ := f.post(t, closePath, tok, uuid.NewString(),
			map[string]any{"payment_method": "cash", "account_id": accountID, "shift_id": shiftID})
		if respC.StatusCode != 200 {
			t.Fatal(respC.StatusCode)
		}
	}

	resp, body := f.downloadXLSXRaw(t, "/api/v1/reports/pl.xlsx", tok)
	if resp.StatusCode != 200 {
		t.Fatalf("pl status %d: %s", resp.StatusCode, body)
	}
	xf, err := excelize.OpenReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("open xlsx: %v", err)
	}
	defer xf.Close()
	sheets := xf.GetSheetList()
	if len(sheets) != 2 {
		t.Errorf("sheets = %d, want 2 (Summary + By day)", len(sheets))
	}
	rows, _ := xf.GetRows("Summary")
	// header + 6 rows (Выручка, COGS, Списания, Хоз.расход, Прибыль, Чеков).
	if len(rows) < 7 {
		t.Fatalf("Summary rows = %d", len(rows))
	}
	// Revenue = 100 (2 чека × 50).
	if rows[1][1] != "100" {
		t.Errorf("revenue row = %v, want 100", rows[1])
	}
	// Orders count = 2.
	if rows[6][1] != "2" {
		t.Errorf("orders count = %v, want 2", rows[6])
	}
}

// downloadXLSXRaw — как downloadXLSX, но возвращает raw body для случаев
// когда нужно открывать excelize самостоятельно.
func (f *e2eFixture) downloadXLSXRaw(t *testing.T, path, token string) (*http.Response, []byte) {
	t.Helper()
	req, _ := http.NewRequest("GET", f.srv.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}

// ─── SSE license.updated на Activate ──────────────────────────────────────

// readSSEUntilEvent читает SSE-поток и ждёт event указанного типа.
// Возвращает payload (data:) или ошибку timeout.
func readSSEUntilEvent(t *testing.T, baseURL, tok, eventType string, timeout time.Duration) (string, error) {
	t.Helper()
	ctx, cancel := context.WithTimeout(context.Background(), timeout)
	defer cancel()
	req, _ := http.NewRequestWithContext(ctx, "GET", baseURL+"/api/v1/events", nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return "", err
	}
	defer resp.Body.Close()
	if resp.StatusCode != 200 {
		return "", fmt.Errorf("status %d", resp.StatusCode)
	}
	sc := bufio.NewScanner(resp.Body)
	var currentEvent string
	for sc.Scan() {
		line := sc.Text()
		if strings.HasPrefix(line, "event: ") {
			currentEvent = strings.TrimPrefix(line, "event: ")
		} else if strings.HasPrefix(line, "data: ") {
			if currentEvent == eventType {
				return strings.TrimPrefix(line, "data: "), nil
			}
		}
	}
	if err := sc.Err(); err != nil {
		return "", err
	}
	return "", fmt.Errorf("scanner ended without %s event", eventType)
}

func TestPhase7b_SSEOnActivate(t *testing.T) {
	lf := setupLicense(t)
	f := lf.toE2E()
	tok := f.login(t)

	// Подключаемся к SSE в фоне, ждём license.updated.
	gotCh := make(chan string, 1)
	errCh := make(chan error, 1)
	go func() {
		data, err := readSSEUntilEvent(t, lf.srv.URL, tok, "license.updated", 3*time.Second)
		if err != nil {
			errCh <- err
			return
		}
		gotCh <- data
	}()

	// Даём SSE подписаться (быстро, но не мгновенно).
	time.Sleep(200 * time.Millisecond)

	// Выписываем + активируем токен.
	now := time.Now().UTC()
	licTok, _ := license.Sign(lf.priv, license.Payload{
		Version: license.CurrentVersion, RestaurantID: lf.rid,
		IssuedAt: now, ExpiresAt: now.AddDate(0, 0, 30), Edition: license.EditionPro,
	})
	resp, body := f.post(t, "/api/v1/license/activate", tok, uuid.NewString(),
		map[string]any{"token": licTok})
	if resp.StatusCode != 200 {
		t.Fatalf("activate %d: %s", resp.StatusCode, body)
	}

	select {
	case data := <-gotCh:
		var st struct {
			State string `json:"state"`
		}
		_ = json.Unmarshal([]byte(data), &st)
		if st.State != "active" {
			t.Errorf("SSE state = %s, want active", st.State)
		}
	case err := <-errCh:
		t.Fatalf("SSE error: %v", err)
	case <-time.After(3 * time.Second):
		t.Fatal("timeout waiting for license.updated SSE event")
	}
}

// Avoid unused.
var _ = decimal.Zero
