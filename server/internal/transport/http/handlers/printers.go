package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type PrintersHandler struct {
	svc *service.PrintersService
}

func NewPrinters(svc *service.PrintersService) *PrintersHandler { return &PrintersHandler{svc: svc} }

// List — GET /api/v1/printers.
func (h *PrintersHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Printer](rows, ""))
}

// Get — GET /api/v1/printers/{id}.
func (h *PrintersHandler) Get(w http.ResponseWriter, r *http.Request) {
	p, err := h.svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, p)
}

// Create — POST /api/v1/printers.
func (h *PrintersHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.PrinterInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	p, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, p)
}

// Patch — PATCH /api/v1/printers/{id}.
func (h *PrintersHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.PrinterInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	p, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, p)
}

// Delete — DELETE /api/v1/printers/{id}.
func (h *PrintersHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Test — POST /api/v1/printers/{id}/test.
// Возвращает 202 Accepted + созданный print_job (воркер обработает асинхронно).
func (h *PrintersHandler) Test(w http.ResponseWriter, r *http.Request) {
	j, err := h.svc.Test(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusAccepted, j)
}
