package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/restos/restos-v4/server/internal/jobs"
	"github.com/restos/restos-v4/server/internal/pkg/license"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type LicenseHandler struct {
	svc *service.LicenseService
	ntp *jobs.NTPChecker
}

func NewLicense(svc *service.LicenseService) *LicenseHandler { return &LicenseHandler{svc: svc} }

// WithNTP — устанавливает NTPChecker для /license/clock-status.
func (h *LicenseHandler) WithNTP(n *jobs.NTPChecker) *LicenseHandler {
	h.ntp = n
	return h
}

// ClockStatus — GET /api/v1/license/clock-status.
// Возвращает последний результат NTP-проверки (v2.6.0+). Если drift > 1ч →
// клиент показывает banner «время на машине сдвинуто, проверьте часы».
func (h *LicenseHandler) ClockStatus(w http.ResponseWriter, r *http.Request) {
	if h.ntp == nil {
		respond.JSON(w, http.StatusOK, map[string]any{
			"enabled": false,
			"message": "ntp checker not configured",
		})
		return
	}
	st := h.ntp.Status()
	respond.JSON(w, http.StatusOK, map[string]any{
		"enabled":        true,
		"last_check_at":  st.LastCheckAt,
		"ntp_server":     st.NTPServer,
		"offset_seconds": st.OffsetSeconds,
		"drift":          st.Drift,
		"error":          st.Error,
	})
}

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

// PublicMachineInfo — GET /api/v1/public/machine-info.
// Без auth — используется onboarding-экраном Kotlin APK / Electron, чтобы
// проверить что адрес действительно RestOS-бэк, до логина.
func (h *LicenseHandler) PublicMachineInfo(w http.ResponseWriter, r *http.Request) {
	info, err := h.svc.PublicMachineInfo(r.Context())
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
