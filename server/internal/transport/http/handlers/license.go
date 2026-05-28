package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type LicenseHandler struct {
	svc *service.LicenseService
}

func NewLicense(svc *service.LicenseService) *LicenseHandler { return &LicenseHandler{svc: svc} }

// Status — GET /api/v1/license/status.
func (h *LicenseHandler) Status(w http.ResponseWriter, r *http.Request) {
	st, err := h.svc.Status(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, st)
}

// Activate — POST /api/v1/license/activate.
func (h *LicenseHandler) Activate(w http.ResponseWriter, r *http.Request) {
	var in service.ActivateInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	st, err := h.svc.Activate(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, st)
}
