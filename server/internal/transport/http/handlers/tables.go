package handlers

import (
	"net/http"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type TablesHandler struct {
	svc *service.TablesService
}

func NewTables(svc *service.TablesService) *TablesHandler { return &TablesHandler{svc: svc} }

// ListZones — GET /api/v1/zones.
func (h *TablesHandler) ListZones(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListZones(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Zone](rows, ""))
}

// ListTables — GET /api/v1/tables. Query: zone_id, status.
func (h *TablesHandler) ListTables(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListTables(r.Context(), service.TablesFilter{
		ZoneID: queryString(r, "zone_id"),
		Status: queryString(r, "status"),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.TableWithEnriched](rows, ""))
}
