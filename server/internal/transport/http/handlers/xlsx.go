package handlers

import (
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// ImportHandler + ReportsHandler.

type ImportHandler struct {
	svc *service.ImportService
}

func NewImport(svc *service.ImportService) *ImportHandler { return &ImportHandler{svc: svc} }

// MenuItems — POST /api/v1/menu/items/import (multipart "file").
func (h *ImportHandler) MenuItems(w http.ResponseWriter, r *http.Request) {
	file, err := openUpload(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	defer file.Close()
	res, err := h.svc.ImportMenuItems(r.Context(), file)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// Ingredients — POST /api/v1/stock/ingredients/import.
func (h *ImportHandler) Ingredients(w http.ResponseWriter, r *http.Request) {
	file, err := openUpload(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	defer file.Close()
	res, err := h.svc.ImportIngredients(r.Context(), file)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// openUpload — общий хэлпер: достаём первый файл из multipart, кап 20MB.
func openUpload(r *http.Request) (multipartFile, error) {
	if err := r.ParseMultipartForm(20 << 20); err != nil {
		return nil, errBadMultipart("expected multipart/form-data with file field")
	}
	f, _, err := r.FormFile("file")
	if err != nil {
		return nil, errBadMultipart("file field 'file' is required")
	}
	return f, nil
}

type multipartFile interface {
	Read([]byte) (int, error)
	Close() error
}

type errBadMultipart string

func (e errBadMultipart) Error() string { return string(e) }

// ─── Reports ──────────────────────────────────────────────────────────────

type ReportsHandler struct {
	svc *service.ReportsService
}

func NewReports(svc *service.ReportsService) *ReportsHandler { return &ReportsHandler{svc: svc} }

// xlsxResponse — выставляет headers и пишет file как attachment.
func xlsxResponse(w http.ResponseWriter, filename string) {
	w.Header().Set("Content-Type", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet")
	w.Header().Set("Content-Disposition", "attachment; filename=\""+filename+"\"")
}

// Orders — GET /api/v1/reports/orders.xlsx?from=&to=.
func (h *ReportsHandler) Orders(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	xlsxResponse(w, "orders.xlsx")
	if err := h.svc.OrdersReport(r.Context(), f, w); err != nil {
		// Заголовки уже отправлены — лог.
		respond.Error(w, err)
	}
}

// Shift — GET /api/v1/reports/shifts/{id}.xlsx.
func (h *ReportsHandler) Shift(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	xlsxResponse(w, "shift-"+id+".xlsx")
	if err := h.svc.ShiftReport(r.Context(), id, w); err != nil {
		respond.Error(w, err)
	}
}

// StockMovements — GET /api/v1/reports/stock-movements.xlsx?from=&to=&ingredient_id=.
func (h *ReportsHandler) StockMovements(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	in := service.StockMovementsReport{Period: f, IngredientID: queryString(r, "ingredient_id")}
	xlsxResponse(w, "stock-movements.xlsx")
	if err := h.svc.StockMovements(r.Context(), in, w); err != nil {
		respond.Error(w, err)
	}
}

// Audit — GET /api/v1/reports/audit.xlsx?from=&to=.
func (h *ReportsHandler) Audit(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	xlsxResponse(w, "audit.xlsx")
	if err := h.svc.AuditReport(r.Context(), f, w); err != nil {
		respond.Error(w, err)
	}
}

// PnL — GET /api/v1/reports/pl.xlsx?from=&to=.
func (h *ReportsHandler) PnL(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	xlsxResponse(w, "pl.xlsx")
	if err := h.svc.PnLReport(r.Context(), f, w); err != nil {
		respond.Error(w, err)
	}
}

// parsePeriod — парсит ?from=&to= в PeriodFilter (RFC3339).
func parsePeriod(r *http.Request) (service.PeriodFilter, error) {
	var f service.PeriodFilter
	if v := queryString(r, "from"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return f, errBadMultipart("bad ?from (RFC3339 required)")
		}
		f.From = &t
	}
	if v := queryString(r, "to"); v != "" {
		t, err := time.Parse(time.RFC3339, v)
		if err != nil {
			return f, errBadMultipart("bad ?to (RFC3339 required)")
		}
		f.To = &t
	}
	return f, nil
}
