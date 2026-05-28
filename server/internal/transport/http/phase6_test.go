//go:build integration

package http_test

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"testing"
	"time"

	"github.com/google/uuid"
	"github.com/xuri/excelize/v2"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// uploadXLSX отправляет multipart POST с одним полем "file".
func (f *e2eFixture) uploadXLSX(t *testing.T, path, token string, xlsxBytes []byte) (*http.Response, []byte) {
	t.Helper()
	var buf bytes.Buffer
	mw := multipart.NewWriter(&buf)
	fw, _ := mw.CreateFormFile("file", "import.xlsx")
	_, _ = fw.Write(xlsxBytes)
	_ = mw.Close()

	req, _ := http.NewRequest("POST", f.srv.URL+path, &buf)
	req.Header.Set("Content-Type", mw.FormDataContentType())
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	return resp, body
}

// buildXLSX строит in-memory xlsx с заданным header'ом и строками.
func buildXLSX(t *testing.T, header []string, rows [][]string) []byte {
	t.Helper()
	f := excelize.NewFile()
	sheet := f.GetSheetList()[0]
	for i, h := range header {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		_ = f.SetCellValue(sheet, cell, h)
	}
	for ri, row := range rows {
		for ci, v := range row {
			cell, _ := excelize.CoordinatesToCellName(ci+1, ri+2)
			_ = f.SetCellValue(sheet, cell, v)
		}
	}
	var buf bytes.Buffer
	_, _ = f.WriteTo(&buf)
	_ = f.Close()
	return buf.Bytes()
}

func TestPhase6_ImportMenuItems(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// Первый импорт — 2 новых, 1 пропуск (пустое имя).
	xlsxBytes := buildXLSX(t,
		[]string{"name", "price", "category", "station"},
		[][]string{
			{"Lagman", "30", "Hot dishes", "hot_kitchen"},
			{"Mojito", "15", "Bar", "bar"},
			{"", "100", "X", ""},
		},
	)
	resp, body := f.uploadXLSX(t, "/api/v1/menu/items/import", tok, xlsxBytes)
	if resp.StatusCode != 200 {
		t.Fatalf("import %d: %s", resp.StatusCode, body)
	}
	var res struct {
		Created, Updated, Skipped int
	}
	_ = json.Unmarshal(body, &res)
	if res.Created != 2 || res.Skipped != 1 {
		t.Errorf("first import: created=%d skipped=%d (want 2/1), body=%s", res.Created, res.Skipped, body)
	}

	// Повторный импорт того же файла — updated=2.
	resp2, body2 := f.uploadXLSX(t, "/api/v1/menu/items/import", tok, xlsxBytes)
	if resp2.StatusCode != 200 {
		t.Fatalf("reimport %d: %s", resp2.StatusCode, body2)
	}
	_ = json.Unmarshal(body2, &res)
	if res.Updated != 2 || res.Created != 0 {
		t.Errorf("re-import: updated=%d created=%d (want 2/0)", res.Updated, res.Created)
	}

	// Проверяем GET /menu/items.
	gr, gb := f.get(t, "/api/v1/menu/items?q=Lagman", tok)
	if gr.StatusCode != 200 {
		t.Fatal(gr.StatusCode)
	}
	var env struct {
		Data []models.MenuItem `json:"data"`
	}
	_ = json.Unmarshal(gb, &env)
	if len(env.Data) != 1 || env.Data[0].Name == nil || *env.Data[0].Name != "Lagman" {
		t.Errorf("Lagman not found in list: %d items", len(env.Data))
	}
}

func TestPhase6_ImportIngredients(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	xlsxBytes := buildXLSX(t,
		[]string{"name", "unit", "category", "min_qty", "price_per_unit"},
		[][]string{
			{"Beef", "kg", "Meat", "5", "200"},
			{"Salt", "kg", "Spice", "1", "10"},
		},
	)
	resp, body := f.uploadXLSX(t, "/api/v1/stock/ingredients/import", tok, xlsxBytes)
	if resp.StatusCode != 200 {
		t.Fatalf("import %d: %s", resp.StatusCode, body)
	}
	var res struct{ Created, Updated int }
	_ = json.Unmarshal(body, &res)
	if res.Created != 2 {
		t.Errorf("ingredients import: created=%d (want 2)", res.Created)
	}
}

func TestPhase6_ImportValidation(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)

	// xlsx без обязательного header "price".
	xlsxBytes := buildXLSX(t, []string{"name", "category"}, [][]string{{"X", "Y"}})
	resp, body := f.uploadXLSX(t, "/api/v1/menu/items/import", tok, xlsxBytes)
	if resp.StatusCode != 400 {
		t.Errorf("missing price header expected 400, got %d (body: %s)", resp.StatusCode, body)
	}
}

// downloadXLSX — GET с Bearer, парсит ответ как xlsx, возвращает rows первого листа.
func (f *e2eFixture) downloadXLSX(t *testing.T, path, token string) (*http.Response, [][]string) {
	t.Helper()
	req, _ := http.NewRequest("GET", f.srv.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+token)
	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp.Body.Close()
	body, _ := io.ReadAll(resp.Body)
	if resp.StatusCode != 200 {
		t.Fatalf("status %d: %s", resp.StatusCode, body)
	}
	xf, err := excelize.OpenReader(bytes.NewReader(body))
	if err != nil {
		t.Fatalf("xlsx open: %v (first 100 bytes: %x)", err, body[:min(100, len(body))])
	}
	defer xf.Close()
	rows, err := xf.GetRows(xf.GetSheetList()[0])
	if err != nil {
		t.Fatal(err)
	}
	return resp, rows
}

func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}

func TestPhase6_OrdersReport(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// Создадим 2 заказа.
	for i := 0; i < 2; i++ {
		resp, _ := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
			map[string]any{"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}}})
		if resp.StatusCode != 201 {
			t.Fatal(resp.StatusCode)
		}
	}

	// Download report.
	resp, rows := f.downloadXLSX(t, "/api/v1/reports/orders.xlsx", tok)
	if ct := resp.Header.Get("Content-Type"); ct != "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" {
		t.Errorf("wrong content-type: %s", ct)
	}
	if cd := resp.Header.Get("Content-Disposition"); cd == "" {
		t.Errorf("missing Content-Disposition")
	}
	// header + 2 строки.
	if len(rows) != 3 {
		t.Errorf("rows = %d, want 3 (header+2 orders)", len(rows))
	}
	if rows[0][0] != "№" {
		t.Errorf("first header = %q, want '№'", rows[0][0])
	}
}

func TestPhase6_ShiftReport(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, shiftID, accountID := seedForWrite(t, f)

	// Закрытый заказ в смене.
	resp, body := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}}})
	if resp.StatusCode != 201 {
		t.Fatal(resp.StatusCode)
	}
	var o models.Order
	_ = json.Unmarshal(body, &o)
	closePath := fmt.Sprintf("/api/v1/orders/%s/close", o.ID)
	respC, _ := f.post(t, closePath, tok, uuid.NewString(),
		map[string]any{"payment_method": "cash", "account_id": accountID, "shift_id": shiftID})
	if respC.StatusCode != 200 {
		t.Fatal(respC.StatusCode)
	}

	// Download Z-report. У книги 3 листа — проверим существование.
	path := fmt.Sprintf("/api/v1/reports/shifts/%s.xlsx", shiftID)
	req, _ := http.NewRequest("GET", f.srv.URL+path, nil)
	req.Header.Set("Authorization", "Bearer "+tok)
	resp2, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer resp2.Body.Close()
	if resp2.StatusCode != 200 {
		t.Fatalf("shift report %d", resp2.StatusCode)
	}
	buf, _ := io.ReadAll(resp2.Body)
	xf, err := excelize.OpenReader(bytes.NewReader(buf))
	if err != nil {
		t.Fatalf("xlsx open: %v", err)
	}
	defer xf.Close()
	sheets := xf.GetSheetList()
	if len(sheets) != 3 {
		t.Errorf("want 3 sheets, got %d (%v)", len(sheets), sheets)
	}
	// Orders sheet должен содержать строку нашего заказа.
	ordersRows, _ := xf.GetRows("Orders")
	if len(ordersRows) < 2 {
		t.Errorf("Orders sheet has no data rows: %d", len(ordersRows))
	}
}

func TestPhase6_StockMovementsAndAudit(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	gdb, _, _, _ := seedForWrite(t, f)

	// Найдём ingredient.
	var ing models.Ingredient
	_ = gdb.Where("restaurant_id = ?", f.rid).First(&ing).Error

	// Receipt → создаст stock_movement.
	respR, _ := f.post(t, "/api/v1/stock/receipts", tok, uuid.NewString(),
		map[string]any{
			"payment_type": "paid",
			"lines": []map[string]any{
				{"ingredient_id": ing.ID, "name": "Rice", "qty": "2", "price_per_unit": "5"},
			},
		})
	if respR.StatusCode != 201 {
		t.Fatal(respR.StatusCode)
	}

	// Download stock movements.
	_, rows := f.downloadXLSX(t, "/api/v1/reports/stock-movements.xlsx", tok)
	if len(rows) < 2 {
		t.Errorf("stock movements rows = %d, want >= 2 (header+receipt)", len(rows))
	}

	// Audit report — точно содержит записи (мы делали create/receipt и т.д.).
	_, auditRows := f.downloadXLSX(t, "/api/v1/reports/audit.xlsx", tok)
	if len(auditRows) < 2 {
		t.Errorf("audit rows = %d, want >= 2", len(auditRows))
	}
}

// TestPhase6_ReportPeriodFilter — only orders within from/to.
func TestPhase6_ReportPeriodFilter(t *testing.T) {
	f := setupE2E(t)
	tok := f.login(t)
	_, menuItemID, _, _ := seedForWrite(t, f)

	// 1 заказ создаём сейчас.
	resp, _ := f.post(t, "/api/v1/orders", tok, uuid.NewString(),
		map[string]any{"items": []map[string]any{{"menu_item_id": menuItemID, "qty": "1"}}})
	if resp.StatusCode != 201 {
		t.Fatal(resp.StatusCode)
	}

	// Period в прошлом → пусто.
	to := time.Now().Add(-24 * time.Hour).UTC().Format(time.RFC3339)
	_, rows := f.downloadXLSX(t, "/api/v1/reports/orders.xlsx?to="+to, tok)
	if len(rows) != 1 {
		t.Errorf("with to=yesterday rows = %d, want 1 (header only)", len(rows))
	}
}
