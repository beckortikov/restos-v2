package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type OrdersHandler struct {
	svc *service.OrdersService
}

func NewOrders(svc *service.OrdersService) *OrdersHandler { return &OrdersHandler{svc: svc} }

// List — GET /api/v1/orders.
// Query: limit, cursor, status, table_id, shift_id, from, to (RFC3339).
func (h *OrdersHandler) List(w http.ResponseWriter, r *http.Request) {
	f := service.OrdersFilter{
		Status:  queryString(r, "status"),
		TableID: queryString(r, "table_id"),
		ShiftID: queryString(r, "shift_id"),
		Page:    parsePage(r),
	}
	if fromStr := queryString(r, "from"); fromStr != "" {
		t, err := time.Parse(time.RFC3339, fromStr)
		if err != nil {
			respond.BadRequest(w, "bad ?from (RFC3339 required)")
			return
		}
		f.From = &t
	}
	if toStr := queryString(r, "to"); toStr != "" {
		t, err := time.Parse(time.RFC3339, toStr)
		if err != nil {
			respond.BadRequest(w, "bad ?to (RFC3339 required)")
			return
		}
		f.To = &t
	}

	rows, next, err := h.svc.List(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.OrderSlim](rows, next))
}

// Get — GET /api/v1/orders/{id}.
func (h *OrdersHandler) Get(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	detail, err := h.svc.Get(r.Context(), id)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, detail)
}

// GetItem — GET /api/v1/order-items/{id}. Точечный lookup позиции для FE,
// чтобы найти order_id по item_id без линейного скана orders.
func (h *OrdersHandler) GetItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	item, err := h.svc.GetByID(r.Context(), id)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, item)
}

// Create — POST /api/v1/orders.
func (h *OrdersHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.CreateOrderInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	order, _, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, order)
}

// AddItems — POST /api/v1/orders/{id}/items.
func (h *OrdersHandler) AddItems(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in service.AddItemsInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	order, _, err := h.svc.AddItems(r.Context(), id, in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, order)
}

// Close — POST /api/v1/orders/{id}/close.
func (h *OrdersHandler) Close(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in service.CloseOrderInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	order, _, err := h.svc.Close(r.Context(), id, in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, order)
}

// Cancel — POST /api/v1/orders/{id}/cancel.
func (h *OrdersHandler) Cancel(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in service.CancelOrderInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	order, err := h.svc.Cancel(r.Context(), id, in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, order)
}

// VoidItem — POST /api/v1/orders/{id}/items/{itemId}/void.
func (h *OrdersHandler) VoidItem(w http.ResponseWriter, r *http.Request) {
	orderID := chi.URLParam(r, "id")
	itemID := chi.URLParam(r, "itemId")
	var in service.VoidItemInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	item, err := h.svc.VoidItem(r.Context(), orderID, itemID, in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, item)
}

// Split — POST /api/v1/orders/{id}/split.
func (h *OrdersHandler) Split(w http.ResponseWriter, r *http.Request) {
	var in service.SplitInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.Split(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// Patch — PATCH /api/v1/orders/{id}. Partial update non-terminal fields.
func (h *OrdersHandler) Patch(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in service.OrderPatchInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	order, err := h.svc.PatchOrder(r.Context(), id, in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, order)
}

// StartCooking — POST /api/v1/orders/{id}/start-cooking.
func (h *OrdersHandler) StartCooking(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in service.StartCookingInput
	if r.ContentLength > 0 {
		_ = json.NewDecoder(r.Body).Decode(&in)
	}
	order, err := h.svc.StartCooking(r.Context(), id, in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, order)
}

// MarkOrderReady — POST /api/v1/orders/{id}/mark-ready.
func (h *OrdersHandler) MarkOrderReady(w http.ResponseWriter, r *http.Request) {
	order, err := h.svc.MarkReady(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, order)
}

// MarkOrderServed — POST /api/v1/orders/{id}/mark-served.
func (h *OrdersHandler) MarkOrderServed(w http.ResponseWriter, r *http.Request) {
	order, err := h.svc.MarkServed(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, order)
}

// Transfer — POST /api/v1/orders/{id}/transfer.
func (h *OrdersHandler) Transfer(w http.ResponseWriter, r *http.Request) {
	var in service.TransferInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	o, err := h.svc.Transfer(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, o)
}
