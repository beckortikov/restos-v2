package handlers

// Trends handler — «Динамика» (deep analytics): временные ряды выручки, заказов,
// среднего чека и расходов. JSON для экрана + XLSX-выгрузка.

import (
	"net/http"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type TrendsHandler struct {
	svc *service.TrendsService
}

func NewTrends(svc *service.TrendsService) *TrendsHandler {
	return &TrendsHandler{svc: svc}
}

// Trends — GET /api/v1/analytics/trends?from=&to=&granularity=day|week|month.
func (h *TrendsHandler) Trends(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.Trends(r.Context(), f, queryString(r, "granularity"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Export — GET /api/v1/analytics/trends.xlsx?from=&to=&granularity=.
func (h *TrendsHandler) Export(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	xlsxResponse(w, "trends.xlsx")
	if err := h.svc.TrendsXLSX(r.Context(), f, queryString(r, "granularity"), w); err != nil {
		respond.Error(w, err)
	}
}
