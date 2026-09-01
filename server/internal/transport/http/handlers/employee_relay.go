package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/middleware"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// EmployeeRelayHandler — central управляет сотрудником филиала (097, см.
// service/employee_relay.go). Request*/History — обычная user-сессия
// (central-сторона), Pending/Ack — sync-токен (филиал), та же авторизация,
// что /sync/*.
type EmployeeRelayHandler struct {
	svc *service.EmployeeRelayService
}

func NewEmployeeRelay(svc *service.EmployeeRelayService) *EmployeeRelayHandler {
	return &EmployeeRelayHandler{svc: svc}
}

// Create — POST /api/v1/employee-relay. Central создаёт сотрудника филиалу.
func (h *EmployeeRelayHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.CreateEmployeeRelayInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	row, err := h.svc.RequestCreate(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, row)
}

// UpdateIdentity — POST /api/v1/employee-relay/{user_id}/identity.
func (h *EmployeeRelayHandler) UpdateIdentity(w http.ResponseWriter, r *http.Request) {
	var in service.UserInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	row, err := h.svc.RequestUpdateIdentity(r.Context(), chi.URLParam(r, "user_id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, row)
}

// UpdatePay — POST /api/v1/employee-relay/{user_id}/pay.
func (h *EmployeeRelayHandler) UpdatePay(w http.ResponseWriter, r *http.Request) {
	var in service.UserInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	row, err := h.svc.RequestUpdatePay(r.Context(), chi.URLParam(r, "user_id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, row)
}

// SetWorkedDays — POST /api/v1/employee-relay/{user_id}/worked-days.
func (h *EmployeeRelayHandler) SetWorkedDays(w http.ResponseWriter, r *http.Request) {
	var in service.SetWorkedDaysRelayInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	row, err := h.svc.RequestSetWorkedDays(r.Context(), chi.URLParam(r, "user_id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, row)
}

// ToggleDayMultiplier — POST /api/v1/employee-relay/{user_id}/day-multiplier.
func (h *EmployeeRelayHandler) ToggleDayMultiplier(w http.ResponseWriter, r *http.Request) {
	var in service.ToggleDayMultiplierRelayInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	row, err := h.svc.RequestToggleDayMultiplier(r.Context(), chi.URLParam(r, "user_id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, row)
}

// History — GET /api/v1/employee-relay/history?limit=N. Central-сторона.
func (h *EmployeeRelayHandler) History(w http.ResponseWriter, r *http.Request) {
	limit, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	rows, err := h.svc.ListHistory(r.Context(), limit)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"actions": rows})
}

// Pending — GET /api/v1/sync/employees/pending?restaurant_id=X. Филиал тянет
// свои pending-команды.
func (h *EmployeeRelayHandler) Pending(w http.ResponseWriter, r *http.Request) {
	restaurantID := r.URL.Query().Get("restaurant_id")
	rows, err := h.svc.ListPending(r.Context(), restaurantID)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"actions": rows})
}

// Ack — POST /api/v1/sync/employees/{id}/ack. Филиал подтверждает результат
// материализации (delivered|failed).
func (h *EmployeeRelayHandler) Ack(w http.ResponseWriter, r *http.Request) {
	var in service.AckEmployeeRelayInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	// Личный sync-токен филиала сужает ack ТОЛЬКО его собственными строками;
	// легаси общий секрет узел не опознаёт (caller="") — тогда не сужаем, как
	// и в остальных /sync/* хендлерах (см. middleware.SyncAuth).
	caller, _ := middleware.SyncCallerID(r.Context())
	if err := h.svc.Ack(r.Context(), chi.URLParam(r, "id"), caller, in); err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}

// SetSchedule — POST /api/v1/employee-relay/{user_id}/schedule (104).
func (h *EmployeeRelayHandler) SetSchedule(w http.ResponseWriter, r *http.Request) {
	var in service.SetScheduleRelayInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	row, err := h.svc.RequestSetSchedule(r.Context(), chi.URLParam(r, "user_id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, row)
}

// SetScheduleDay — POST /api/v1/employee-relay/{user_id}/schedule-day (104).
func (h *EmployeeRelayHandler) SetScheduleDay(w http.ResponseWriter, r *http.Request) {
	var in service.SetScheduleDayRelayInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	row, err := h.svc.RequestSetScheduleDay(r.Context(), chi.URLParam(r, "user_id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, row)
}
