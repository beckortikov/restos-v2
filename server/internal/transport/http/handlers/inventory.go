package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type InventoryHandler struct {
	svc *service.InventoryService
}

func NewInventory(svc *service.InventoryService) *InventoryHandler {
	return &InventoryHandler{svc: svc}
}

// Create — POST /api/v1/stock/inventory.
func (h *InventoryHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.InventoryCheckInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	check, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, check)
}

// Apply — POST /api/v1/stock/inventory/{id}/apply.
func (h *InventoryHandler) Apply(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	check, err := h.svc.Apply(r.Context(), id)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, check)
}
