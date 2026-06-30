package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// TransfersHandler — перемещения товара между филиалами сети (ADR-003, Фаза 1).
type TransfersHandler struct {
	svc *service.TransferService
}

func NewTransfers(svc *service.TransferService) *TransfersHandler {
	return &TransfersHandler{svc: svc}
}

// List — GET /api/v1/stock/transfers. Перемещения, где текущий ресторан —
// источник или получатель.
func (h *TransfersHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.StockTransfer](rows, ""))
}

// Get — GET /api/v1/stock/transfers/{id}.
func (h *TransfersHandler) Get(w http.ResponseWriter, r *http.Request) {
	t, err := h.svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}

// Create — POST /api/v1/stock/transfers. Создаёт и сразу отправляет
// (status=sent, transfer_out у источника).
func (h *TransfersHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.CreateTransferInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.CreateTransfer(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, t)
}

// Receive — POST /api/v1/stock/transfers/{id}/receive. Приём получателем
// (transfer_in). Идемпотентно.
func (h *TransfersHandler) Receive(w http.ResponseWriter, r *http.Request) {
	t, err := h.svc.Receive(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}
