package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type StockHandler struct {
	svc *service.StockService
}

func NewStock(svc *service.StockService) *StockHandler { return &StockHandler{svc: svc} }

// ListIngredients — GET /api/v1/stock/ingredients.
// Query: limit, cursor, category, q, low=true.
func (h *StockHandler) ListIngredients(w http.ResponseWriter, r *http.Request) {
	rows, next, err := h.svc.ListIngredients(r.Context(), service.IngredientsFilter{
		Category: queryString(r, "category"),
		Query:    queryString(r, "q"),
		LowOnly:  queryString(r, "low") == "true",
		Page:     parsePage(r),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Ingredient](rows, next))
}

// CreateReceipt — POST /api/v1/stock/receipts.
func (h *StockHandler) CreateReceipt(w http.ResponseWriter, r *http.Request) {
	var in service.ReceiptInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	receipt, err := h.svc.CreateReceipt(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, receipt)
}

// CreateWriteoff — POST /api/v1/stock/writeoffs.
func (h *StockHandler) CreateWriteoff(w http.ResponseWriter, r *http.Request) {
	var in service.WriteoffInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	wo, err := h.svc.CreateWriteoff(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, wo)
}
