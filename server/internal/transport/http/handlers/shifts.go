package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type ShiftsHandler struct {
	svc *service.ShiftsService
}

func NewShifts(svc *service.ShiftsService) *ShiftsHandler { return &ShiftsHandler{svc: svc} }

// List — GET /api/v1/shifts. Query: status, limit, cursor.
func (h *ShiftsHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, next, err := h.svc.List(r.Context(), service.ShiftsFilter{
		Status: queryString(r, "status"),
		Page:   parsePage(r),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.ShiftWithAccount](rows, next))
}

// Get — GET /api/v1/shifts/{id}.
func (h *ShiftsHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	detail, err := h.svc.Get(r.Context(), id)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, detail)
}

// Open — POST /api/v1/shifts.
func (h *ShiftsHandler) Open(w http.ResponseWriter, r *http.Request) {
	var in service.OpenShiftInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	shift, err := h.svc.Open(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, shift)
}

// Close — POST /api/v1/shifts/{id}/close.
func (h *ShiftsHandler) Close(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in service.CloseShiftInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	shift, err := h.svc.Close(r.Context(), id, in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, shift)
}

// AddOperation — POST /api/v1/shifts/{id}/operations.
func (h *ShiftsHandler) AddOperation(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in service.ShiftOperationInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	op, err := h.svc.AddOperation(r.Context(), id, in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, op)
}
