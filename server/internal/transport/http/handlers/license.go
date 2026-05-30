package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/restos/restos-v4/server/internal/pkg/license"
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

// MachineInfo — GET /api/v1/license/machine-id.
// Возвращает fingerprint текущей машины + restaurant_id чтобы клиент
// мог скопировать и отправить админу для выписки токена.
//
// Не требует уже активной лицензии (наоборот, нужно для первой активации).
func (h *LicenseHandler) MachineInfo(w http.ResponseWriter, r *http.Request) {
	info, err := h.svc.MachineInfo(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, info)
}

// silence unused-import linter if license pkg used only in service for now.
var _ = license.MachineID

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
