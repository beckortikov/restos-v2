package handlers

import (
	"net/http"
	"time"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// MaintenanceHandler — разовые обслуживающие операции (Н13-ретро коррекция).
type MaintenanceHandler struct{ svc *service.MaintenanceService }

func NewMaintenance(svc *service.MaintenanceService) *MaintenanceHandler {
	return &MaintenanceHandler{svc: svc}
}

// parseCutoff — момент, ДО которого расходы кассы не дебетовали счёт (дата
// установки фикса v3.16.94). RFC3339 или YYYY-MM-DD; по умолчанию — сейчас.
func parseCutoff(r *http.Request) time.Time {
	c := r.URL.Query().Get("cutoff")
	if c == "" {
		return time.Now().UTC()
	}
	if t, err := time.Parse(time.RFC3339, c); err == nil {
		return t.UTC()
	}
	if t, err := time.Parse("2006-01-02", c); err == nil {
		return t.UTC()
	}
	return time.Now().UTC()
}

// ShiftBalanceFixPreview — GET: что будет скорректировано (без изменений).
func (h *MaintenanceHandler) ShiftBalanceFixPreview(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.PreviewShiftBalanceFix(r.Context(), parseCutoff(r))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// ShiftBalanceFixApply — POST: применяет коррекцию РОВНО ОДИН РАЗ.
func (h *MaintenanceHandler) ShiftBalanceFixApply(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.ApplyShiftBalanceFix(r.Context(), parseCutoff(r))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}
