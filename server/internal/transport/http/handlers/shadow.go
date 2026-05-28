package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type ShadowHandler struct {
	svc *service.ShadowService
}

func NewShadow(svc *service.ShadowService) *ShadowHandler { return &ShadowHandler{svc: svc} }

// Ingest — POST /api/v1/admin/shadow/reports.
// Batch endpoint: фронт шлёт массив отчётов раз в N секунд.
func (h *ShadowHandler) Ingest(w http.ResponseWriter, r *http.Request) {
	var in service.ShadowReportInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	n, err := h.svc.Ingest(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusAccepted, map[string]any{"accepted": n})
}

// Stats — GET /api/v1/admin/shadow/stats?from=&to=.
func (h *ShadowHandler) Stats(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	st, err := h.svc.Stats(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, st)
}

// RecentDrifts — GET /api/v1/admin/shadow/drifts?limit=50.
func (h *ShadowHandler) RecentDrifts(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(queryString(r, "limit"))
	rows, err := h.svc.RecentDrifts(r.Context(), limit)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"data": rows})
}
