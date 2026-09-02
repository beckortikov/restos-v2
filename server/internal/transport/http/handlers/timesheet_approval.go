package handlers

import (
	"net/http"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// ─── Утверждение табеля (106) ──────────────────────────────────────────────

type TimesheetApprovalHandler struct {
	svc *service.TimesheetApprovalService
}

func NewTimesheetApproval(svc *service.TimesheetApprovalService) *TimesheetApprovalHandler {
	return &TimesheetApprovalHandler{svc: svc}
}

// Status — GET /api/v1/timesheet/approval?from&to.
func (h *TimesheetApprovalHandler) Status(w http.ResponseWriter, r *http.Request) {
	st, err := h.svc.Status(r.Context(), queryString(r, "from"), queryString(r, "to"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, st)
}

type approvalPeriodReq struct {
	From string `json:"from"`
	To   string `json:"to"`
}

// Approve — POST /api/v1/timesheet/approval.
func (h *TimesheetApprovalHandler) Approve(w http.ResponseWriter, r *http.Request) {
	var in approvalPeriodReq
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	st, err := h.svc.Approve(r.Context(), in.From, in.To)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, st)
}

// Cancel — POST /api/v1/timesheet/approval/cancel: переоткрыть период.
func (h *TimesheetApprovalHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	var in approvalPeriodReq
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	if err := h.svc.Cancel(r.Context(), in.From, in.To); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// WorkedHours — GET /api/v1/timesheet/hours?from&to — часы и дни по каждому.
func (h *TimesheetApprovalHandler) WorkedHours(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.WorkedHours(r.Context(), queryString(r, "from"), queryString(r, "to"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.WorkedHoursRow](rows, ""))
}
