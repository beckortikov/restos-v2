package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type BootstrapHandler struct {
	svc *service.BootstrapService
}

func NewBootstrap(svc *service.BootstrapService) *BootstrapHandler {
	return &BootstrapHandler{svc: svc}
}

// Status — GET /api/v1/bootstrap/status (публично, без auth).
// Возвращает {initialized: bool} — фронт решает что показать.
func (h *BootstrapHandler) Status(w http.ResponseWriter, r *http.Request) {
	init, err := h.svc.IsInitialized(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"initialized": init})
}

// Run — POST /api/v1/bootstrap (публично, без auth; защищено CONFLICT-чеком).
func (h *BootstrapHandler) Run(w http.ResponseWriter, r *http.Request) {
	var in service.BootstrapInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.Run(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, res)
}
