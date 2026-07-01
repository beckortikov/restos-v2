package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// SyncHandler — приём дельт на центральном узле (ADR-003, Фаза 2).
type SyncHandler struct {
	svc *service.SyncService
}

func NewSync(svc *service.SyncService) *SyncHandler {
	return &SyncHandler{svc: svc}
}

// Ingest — POST /api/v1/sync/ingest. Филиал пушит батч дельг sync_log.
func (h *SyncHandler) Ingest(w http.ResponseWriter, r *http.Request) {
	var in service.IngestInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Ingest(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}
