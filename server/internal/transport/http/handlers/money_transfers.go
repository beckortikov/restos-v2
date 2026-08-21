package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// MoneyTransfersHandler — переводы денег между узлами сети (ADR-003, Фаза Д).
type MoneyTransfersHandler struct {
	svc *service.MoneyTransferService
}

func NewMoneyTransfers(svc *service.MoneyTransferService) *MoneyTransfersHandler {
	return &MoneyTransfersHandler{svc: svc}
}

// List — GET /api/v1/money/transfers. Переводы, где текущий ресторан —
// отправитель или получатель.
func (h *MoneyTransfersHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.MoneyTransfer](rows, ""))
}

// Get — GET /api/v1/money/transfers/{id}.
func (h *MoneyTransfersHandler) Get(w http.ResponseWriter, r *http.Request) {
	t, err := h.svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}

// Create — POST /api/v1/money/transfers. Списывает со счёта отправителя и
// отправляет (status=sent).
func (h *MoneyTransfersHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.CreateMoneyTransferInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, t)
}

// Receive — POST /api/v1/money/transfers/{id}/receive. Зачисление на счёт
// получателя (он выбирает счёт). Идемпотентно.
func (h *MoneyTransfersHandler) Receive(w http.ResponseWriter, r *http.Request) {
	var in service.ReceiveMoneyTransferInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.Receive(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}
