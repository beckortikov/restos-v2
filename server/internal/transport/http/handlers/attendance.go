package handlers

import (
	"net/http"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// ─── Attendance — терминал учёта рабочего времени (:checkin) ────────────────

type AttendanceHandler struct{ svc *service.AttendanceService }

func NewAttendance(svc *service.AttendanceService) *AttendanceHandler {
	return &AttendanceHandler{svc: svc}
}

// attendancePinReq — PIN всегда в ТЕЛЕ, никогда в query: строка запроса
// попадает в логи прокси и в историю, а это рабочий пароль сотрудника.
type attendancePinReq struct {
	PIN string `json:"pin"`
}

type attendancePunchReq struct {
	PIN    string `json:"pin"`
	Action string `json:"action"` // "in" | "out"
}

// Lookup — POST /api/v1/attendance/lookup.
func (h *AttendanceHandler) Lookup(w http.ResponseWriter, r *http.Request) {
	var in attendancePinReq
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.Lookup(r.Context(), in.PIN)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// Punch — POST /api/v1/attendance/punch.
func (h *AttendanceHandler) Punch(w http.ResponseWriter, r *http.Request) {
	var in attendancePunchReq
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.Punch(r.Context(), in.PIN, in.Action)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// OnShift — GET /api/v1/attendance/on-shift.
func (h *AttendanceHandler) OnShift(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.OnShift(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.AttendanceOnShiftRow](rows, ""))
}
