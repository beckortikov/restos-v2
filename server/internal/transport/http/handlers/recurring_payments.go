package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// RecurringPaymentsHandler — модуль «Платежи» (регулярные платежи).
type RecurringPaymentsHandler struct {
	svc *service.RecurringPaymentsService
}

func NewRecurringPayments(svc *service.RecurringPaymentsService) *RecurringPaymentsHandler {
	return &RecurringPaymentsHandler{svc: svc}
}

// List — GET /api/v1/finance/recurring-payments.
func (h *RecurringPaymentsHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.RecurringPayment](rows, ""))
}

// Create — POST /api/v1/finance/recurring-payments.
func (h *RecurringPaymentsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.RecurringPaymentInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	rp, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, rp)
}

// Patch — PATCH /api/v1/finance/recurring-payments/{id}.
func (h *RecurringPaymentsHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.RecurringPaymentInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	rp, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, rp)
}

// Delete — DELETE /api/v1/finance/recurring-payments/{id}.
func (h *RecurringPaymentsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// Pay — POST /api/v1/finance/recurring-payments/{id}/pay.
func (h *RecurringPaymentsHandler) Pay(w http.ResponseWriter, r *http.Request) {
	var in service.RecurringPaymentPayInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	rp, err := h.svc.Pay(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, rp)
}
