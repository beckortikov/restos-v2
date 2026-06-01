// Package handlers — extras_e.go: handlers Phase 14 (final cutover endpoints):
//   - Shifts: active, zreport, revenue, operations list, expenses (alias + delete)
//   - StopList: list, override, recompute
//   - Semi ops: prepare, consume
//   - Batch cooking: max-portions, produce, decrement, writeoff, logs
//   - Audit: list with filters + offset pagination
//   - Print extras: reprint, active-by-station
//   - Reservations: for-table
//   - Payroll extras: active clock-in, patch, today-stats
package handlers

import (
	"encoding/json"
	"net/http"
	"strconv"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	"github.com/restos/restos-v4/server/internal/pkg/timeutil"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// ═══════════════════════════════════════════════════════════════════════════
// Shifts extras (active/zreport/revenue/operations/expenses)
// ═══════════════════════════════════════════════════════════════════════════

// Active — GET /api/v1/shifts/active.
func (h *ShiftsHandler) Active(w http.ResponseWriter, r *http.Request) {
	shift, err := h.svc.Active(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, shift)
}

// ZReport — GET /api/v1/shifts/{id}/zreport.
func (h *ShiftsHandler) ZReport(w http.ResponseWriter, r *http.Request) {
	z, err := h.svc.ZReport(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, z)
}

// Revenue — GET /api/v1/shifts/{id}/revenue.
func (h *ShiftsHandler) Revenue(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Revenue(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Operations — GET /api/v1/shifts/{id}/operations.
func (h *ShiftsHandler) Operations(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.Operations(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.CashShiftOperation](rows, ""))
}

// AddExpense — POST /api/v1/shifts/{id}/expenses.
func (h *ShiftsHandler) AddExpense(w http.ResponseWriter, r *http.Request) {
	var in service.ShiftExpenseInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	op, err := h.svc.AddExpense(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, op)
}

// DeleteExpense — DELETE /api/v1/shifts/{id}/expenses/{op_id}.
func (h *ShiftsHandler) DeleteExpense(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.DeleteExpense(r.Context(),
		chi.URLParam(r, "id"), chi.URLParam(r, "op_id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// PrintZ — POST /api/v1/shifts/{id}/print-z. Кладёт PrintJob type='z_report'.
func (h *ShiftsHandler) PrintZ(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.PrintZ(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// PrintX — POST /api/v1/shifts/{id}/print-x. Кладёт PrintJob type='x_report'.
func (h *ShiftsHandler) PrintX(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.PrintX(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// DeleteOperationByID — DELETE /api/v1/cash-shift-operations/{id}.
// Удаляет операцию без shift_id в пути — сервер сам резолвит её родителя
// и применяет tenant-чек.
func (h *ShiftsHandler) DeleteOperationByID(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.DeleteOperation(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ═══════════════════════════════════════════════════════════════════════════
// StopList
// ═══════════════════════════════════════════════════════════════════════════

type StopListHandler struct{ svc *service.StopListService }

func NewStopList(svc *service.StopListService) *StopListHandler { return &StopListHandler{svc: svc} }

// List — GET /api/v1/stop-list.
func (h *StopListHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.StopListItem](rows, ""))
}

// SetOverride — POST /api/v1/stop-list/{menu_item_id}/override.
func (h *StopListHandler) SetOverride(w http.ResponseWriter, r *http.Request) {
	var in service.StopListOverrideInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.SetOverride(r.Context(), chi.URLParam(r, "menu_item_id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Recompute — POST /api/v1/stop-list/recompute.
func (h *StopListHandler) Recompute(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Recompute(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// ═══════════════════════════════════════════════════════════════════════════
// Semi operations (prepare/consume) — на SemiFinishedHandler.
// ═══════════════════════════════════════════════════════════════════════════

// Prepare — POST /api/v1/semi/prepare.
func (h *SemiFinishedHandler) Prepare(w http.ResponseWriter, r *http.Request) {
	var in service.SemiPrepareInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Prepare(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Consume — POST /api/v1/semi/consume.
func (h *SemiFinishedHandler) Consume(w http.ResponseWriter, r *http.Request) {
	var in service.SemiConsumeInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Consume(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// ═══════════════════════════════════════════════════════════════════════════
// Batch cooking
// ═══════════════════════════════════════════════════════════════════════════

type BatchCookingHandler struct{ svc *service.BatchCookingService }

func NewBatchCooking(svc *service.BatchCookingService) *BatchCookingHandler {
	return &BatchCookingHandler{svc: svc}
}

// MaxPortions — GET /api/v1/menu/items/{id}/max-portions.
func (h *BatchCookingHandler) MaxPortions(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.MaxPortions(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Produce — POST /api/v1/menu/items/{id}/batch/produce.
func (h *BatchCookingHandler) Produce(w http.ResponseWriter, r *http.Request) {
	var in service.BatchProduceInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Produce(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Decrement — POST /api/v1/menu/items/{id}/batch/decrement.
func (h *BatchCookingHandler) Decrement(w http.ResponseWriter, r *http.Request) {
	var in service.BatchDecrementInput
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			respond.BadRequest(w, "invalid JSON body")
			return
		}
	}
	out, err := h.svc.Decrement(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Writeoff — POST /api/v1/menu/items/{id}/batch/writeoff.
func (h *BatchCookingHandler) Writeoff(w http.ResponseWriter, r *http.Request) {
	var in service.BatchWriteoffInput
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			respond.BadRequest(w, "invalid JSON body")
			return
		}
	}
	out, err := h.svc.Writeoff(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Logs — GET /api/v1/menu/items/{id}/batch/logs.
func (h *BatchCookingHandler) Logs(w http.ResponseWriter, r *http.Request) {
	rows, next, err := h.svc.Logs(r.Context(), chi.URLParam(r, "id"), cursor.Page{
		Limit:  parseLimit(r),
		Cursor: queryString(r, "cursor"),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.BatchCookingLog](rows, next))
}

// LogsCross — GET /api/v1/menu/batch/logs (без item-id в path; cross-item).
func (h *BatchCookingHandler) LogsCross(w http.ResponseWriter, r *http.Request) {
	from, to, err := parseTimeRange(r)
	if err != nil {
		respond.BadRequest(w, "bad from/to")
		return
	}
	rows, next, err := h.svc.LogsFiltered(r.Context(), service.BatchLogsFilter{
		MenuItemID: queryString(r, "menu_item_id"),
		From:       from, To: to,
		Page: cursor.Page{
			Limit:  parseLimit(r),
			Cursor: queryString(r, "cursor"),
		},
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.BatchCookingLog](rows, next))
}

// ═══════════════════════════════════════════════════════════════════════════
// Audit reads
// ═══════════════════════════════════════════════════════════════════════════

type AuditReadsHandler struct{ svc *service.AuditReadsService }

func NewAuditReads(svc *service.AuditReadsService) *AuditReadsHandler {
	return &AuditReadsHandler{svc: svc}
}

// List — GET /api/v1/audit-log.
func (h *AuditReadsHandler) List(w http.ResponseWriter, r *http.Request) {
	var f service.AuditFilter
	f.EntityType = queryString(r, "entity_type")
	f.Action = queryString(r, "action")
	f.UserID = queryString(r, "user_id")
	f.Limit, _ = strconv.Atoi(queryString(r, "limit"))
	f.Offset, _ = strconv.Atoi(queryString(r, "offset"))
	if v := queryString(r, "from"); v != "" {
		t, err := timeutil.ParseLooseRFC3339(v)
		if err != nil {
			respond.BadRequest(w, "bad ?from")
			return
		}
		f.From = &t
	}
	if v := queryString(r, "to"); v != "" {
		t, err := timeutil.ParseLooseRFC3339(v)
		if err != nil {
			respond.BadRequest(w, "bad ?to")
			return
		}
		f.To = &t
	}
	out, err := h.svc.List(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// ═══════════════════════════════════════════════════════════════════════════
// Print extras — на PrintJobsHandler.
// ═══════════════════════════════════════════════════════════════════════════

// Reprint — POST /api/v1/print/jobs/{id}/reprint.
func (h *PrintJobsHandler) Reprint(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Reprint(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, out)
}

// ActiveByStation — GET /api/v1/print/jobs/active-by-station?station=...
func (h *PrintJobsHandler) ActiveByStation(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ActiveByStation(r.Context(), queryString(r, "station"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.PrintJob](rows, ""))
}

// ═══════════════════════════════════════════════════════════════════════════
// Reservations extras — на ReservationsHandler.
// ═══════════════════════════════════════════════════════════════════════════

// ForTable — GET /api/v1/reservations/for-table/{table_id}.
func (h *ReservationsHandler) ForTable(w http.ResponseWriter, r *http.Request) {
	var f service.ForTableFilter
	if v := queryString(r, "from"); v != "" {
		t, err := timeutil.ParseLooseRFC3339(v)
		if err != nil {
			respond.BadRequest(w, "bad ?from")
			return
		}
		f.From = t
	}
	if v := queryString(r, "to"); v != "" {
		t, err := timeutil.ParseLooseRFC3339(v)
		if err != nil {
			respond.BadRequest(w, "bad ?to")
			return
		}
		f.To = t
	}
	rows, err := h.svc.ForTable(r.Context(), chi.URLParam(r, "table_id"), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Reservation](rows, ""))
}

// ═══════════════════════════════════════════════════════════════════════════
// Payroll extras — на TimeEntriesHandler.
// ═══════════════════════════════════════════════════════════════════════════

// Active — GET /api/v1/time-entries/active?user_id=...
func (h *TimeEntriesHandler) Active(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Active(r.Context(), queryString(r, "user_id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Patch — PATCH /api/v1/time-entries/{id}.
func (h *TimeEntriesHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.TimeEntryPatchInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// WaiterStatsHandler — отдельный handler под /waiters/{id}/today-stats.
type WaiterStatsHandler struct{ svc *service.TimeEntriesService }

func NewWaiterStats(svc *service.TimeEntriesService) *WaiterStatsHandler {
	return &WaiterStatsHandler{svc: svc}
}

// TodayStats — GET /api/v1/waiters/{id}/today-stats.
func (h *WaiterStatsHandler) TodayStats(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.TodayStats(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// ─── helpers ──────────────────────────────────────────────────────────────

func parseLimit(r *http.Request) int {
	n, _ := strconv.Atoi(r.URL.Query().Get("limit"))
	return n
}
