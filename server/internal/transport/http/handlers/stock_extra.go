package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// parseTimeRange — небольшой хэлпер для ?from=&to= (RFC3339).
func parseTimeRange(r *http.Request) (from, to *time.Time, err error) {
	if v := queryString(r, "from"); v != "" {
		t, e := time.Parse(time.RFC3339, v)
		if e != nil {
			return nil, nil, e
		}
		from = &t
	}
	if v := queryString(r, "to"); v != "" {
		t, e := time.Parse(time.RFC3339, v)
		if e != nil {
			return nil, nil, e
		}
		to = &t
	}
	return from, to, nil
}

// ─── Ingredients write ─────────────────────────────────────────────────────

type IngredientsWriteHandler struct {
	svc *service.IngredientsWriteService
}

func NewIngredientsWrite(svc *service.IngredientsWriteService) *IngredientsWriteHandler {
	return &IngredientsWriteHandler{svc: svc}
}

func (h *IngredientsWriteHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.IngredientInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, out)
}

func (h *IngredientsWriteHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.IngredientInput
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

func (h *IngredientsWriteHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Stock reads (receipts/writeoffs/movements/categories) ─────────────────

type StockReadsHandler struct{ svc *service.StockReadsService }

func NewStockReads(svc *service.StockReadsService) *StockReadsHandler {
	return &StockReadsHandler{svc: svc}
}

func (h *StockReadsHandler) ListReceipts(w http.ResponseWriter, r *http.Request) {
	from, to, err := parseTimeRange(r)
	if err != nil {
		respond.BadRequest(w, "bad from/to")
		return
	}
	f := service.ReceiptsFilter{
		SupplierID: queryString(r, "supplier_id"),
		From:       from, To: to,
		Page: parsePage(r),
	}
	if queryString(r, "include") == "lines" {
		rows, next, err := h.svc.ListReceiptsWithLines(r.Context(), f)
		if err != nil {
			respond.Error(w, err)
			return
		}
		respond.JSON(w, http.StatusOK, makeList[service.ReceiptWithLines](rows, next))
		return
	}
	rows, next, err := h.svc.ListReceipts(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.StockReceipt](rows, next))
}

func (h *StockReadsHandler) ListWriteoffs(w http.ResponseWriter, r *http.Request) {
	from, to, err := parseTimeRange(r)
	if err != nil {
		respond.BadRequest(w, "bad from/to")
		return
	}
	f := service.WriteoffsFilter{From: from, To: to, Page: parsePage(r)}
	if queryString(r, "include") == "lines" {
		rows, next, err := h.svc.ListWriteoffsWithLines(r.Context(), f)
		if err != nil {
			respond.Error(w, err)
			return
		}
		respond.JSON(w, http.StatusOK, makeList[service.WriteoffWithLines](rows, next))
		return
	}
	rows, next, err := h.svc.ListWriteoffs(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.StockWriteoff](rows, next))
}

func (h *StockReadsHandler) ListMovements(w http.ResponseWriter, r *http.Request) {
	from, to, err := parseTimeRange(r)
	if err != nil {
		respond.BadRequest(w, "bad from/to")
		return
	}
	rows, next, err := h.svc.ListMovements(r.Context(), service.MovementsFilter{
		IngredientID: queryString(r, "ingredient_id"),
		Type:         queryString(r, "type"),
		From:         from, To: to,
		Page: parsePage(r),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.StockMovement](rows, next))
}

func (h *StockReadsHandler) ListCategories(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListCategories(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[string](rows, ""))
}

// ─── Receipt confirm (on existing StockHandler/svc) ────────────────────────
// Прицеплено к существующему StockHandler для DRY.

func (h *StockHandler) ConfirmReceipt(w http.ResponseWriter, r *http.Request) {
	var in service.ConfirmReceiptInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	receipt, err := h.svc.ConfirmReceipt(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, receipt)
}

// ─── Inventory reads ───────────────────────────────────────────────────────

type InventoryReadsHandler struct {
	svc *service.InventoryReadsService
}

func NewInventoryReads(svc *service.InventoryReadsService) *InventoryReadsHandler {
	return &InventoryReadsHandler{svc: svc}
}

func (h *InventoryReadsHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, next, err := h.svc.List(r.Context(), service.InventoryListFilter{
		Status: queryString(r, "status"),
		Page:   parsePage(r),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.InventoryCheck](rows, next))
}

func (h *InventoryReadsHandler) Get(w http.ResponseWriter, r *http.Request) {
	check, err := h.svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, check)
}

func (h *InventoryReadsHandler) ListLines(w http.ResponseWriter, r *http.Request) {
	lines, err := h.svc.ListLines(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.InventoryCheckLine](lines, ""))
}

// ─── SupplyExpenses ────────────────────────────────────────────────────────

type SupplyExpensesHandler struct {
	svc *service.SupplyExpensesService
}

func NewSupplyExpenses(svc *service.SupplyExpensesService) *SupplyExpensesHandler {
	return &SupplyExpensesHandler{svc: svc}
}

func (h *SupplyExpensesHandler) List(w http.ResponseWriter, r *http.Request) {
	from, to, err := parseTimeRange(r)
	if err != nil {
		respond.BadRequest(w, "bad from/to")
		return
	}
	rows, next, err := h.svc.List(r.Context(), service.SupplyExpensesFilter{
		IngredientID: queryString(r, "ingredient_id"),
		From:         from, To: to,
		Page: parsePage(r),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.SupplyExpense](rows, next))
}

func (h *SupplyExpensesHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.SupplyExpenseInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, out)
}
