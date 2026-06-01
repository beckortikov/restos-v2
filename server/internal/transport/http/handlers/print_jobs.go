package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type PrintJobsHandler struct {
	svc *service.PrintJobsService
}

func NewPrintJobs(svc *service.PrintJobsService) *PrintJobsHandler {
	return &PrintJobsHandler{svc: svc}
}

// List — GET /api/v1/print/jobs. Query: status, type, limit, cursor.
func (h *PrintJobsHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, next, err := h.svc.List(r.Context(), service.PrintJobsFilter{
		Status: queryString(r, "status"),
		Type:   queryString(r, "type"),
		Page:   parsePage(r),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.PrintJobWithEnrich](rows, next))
}

// Retry — POST /api/v1/print/jobs/{id}/retry.
func (h *PrintJobsHandler) Retry(w http.ResponseWriter, r *http.Request) {
	j, err := h.svc.Retry(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, j)
}
