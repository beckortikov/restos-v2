package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// SyncSettingsHandler — конфиг multi-branch sync из UI (ADR-003/004).
type SyncSettingsHandler struct {
	svc *service.SyncSettingsService
}

func NewSyncSettings(svc *service.SyncSettingsService) *SyncSettingsHandler {
	return &SyncSettingsHandler{svc: svc}
}

// Get — GET /api/v1/settings/sync.
func (h *SyncSettingsHandler) Get(w http.ResponseWriter, r *http.Request) {
	st, err := h.svc.Get(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, st)
}

// QueueStats — GET /api/v1/settings/sync/queue. Состояние очереди отправки
// (Фаза О): сколько ждёт, сколько в карантине, когда последний раз уехало.
func (h *SyncSettingsHandler) QueueStats(w http.ResponseWriter, r *http.Request) {
	st, err := h.svc.QueueStats(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, st)
}

// Update — PUT /api/v1/settings/sync.
func (h *SyncSettingsHandler) Update(w http.ResponseWriter, r *http.Request) {
	var in service.UpdateSyncSettingsInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	st, err := h.svc.Update(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, st)
}
