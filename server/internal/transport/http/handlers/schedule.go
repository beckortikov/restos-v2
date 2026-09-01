package handlers

import (
	"net/http"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// ─── Schedule — плановый график смен (102) ─────────────────────────────────

type ScheduleHandler struct {
	svc    *service.ScheduleService
	salary *service.SalaryService
}

func NewSchedule(svc *service.ScheduleService, salary *service.SalaryService) *ScheduleHandler {
	return &ScheduleHandler{svc: svc, salary: salary}
}

// Plan — GET /api/v1/schedule?from&to&user_id.
func (h *ScheduleHandler) Plan(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.Plan(r.Context(), queryString(r, "from"), queryString(r, "to"), queryString(r, "user_id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.PlannedShift](rows, ""))
}

// Template — GET /api/v1/schedule/template?user_id.
func (h *ScheduleHandler) Template(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.Template(r.Context(), queryString(r, "user_id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.ShiftScheduleTemplate](rows, ""))
}

// SetTemplate — PUT /api/v1/schedule/template.
func (h *ScheduleHandler) SetTemplate(w http.ResponseWriter, r *http.Request) {
	var in service.SetTemplateInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	rows, err := h.svc.SetTemplate(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.ShiftScheduleTemplate](rows, ""))
}

// SetDay — PUT /api/v1/schedule/day.
func (h *ScheduleHandler) SetDay(w http.ResponseWriter, r *http.Request) {
	var in service.ScheduleDayInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	row, err := h.svc.SetDay(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, row)
}

// DeleteDay — DELETE /api/v1/schedule/day?user_id&date.
func (h *ScheduleHandler) DeleteDay(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.DeleteDay(r.Context(), queryString(r, "user_id"), queryString(r, "date")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RollCall — GET /api/v1/schedule/roll-call?date.
func (h *ScheduleHandler) RollCall(w http.ResponseWriter, r *http.Request) {
	report, err := h.svc.RollCall(r.Context(), queryString(r, "date"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, report)
}

// FineLate — POST /api/v1/schedule/roll-call/fine {user_id, date} (105).
// Сумма считается на сервере по политике ресторана; из тела берутся только
// «кого» и «за какой день».
func (h *ScheduleHandler) FineLate(w http.ResponseWriter, r *http.Request) {
	var in struct {
		UserID string `json:"user_id"`
		Date   string `json:"date"`
	}
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	row, err := h.svc.FineLate(r.Context(), h.salary, in.UserID, in.Date)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, row)
}
