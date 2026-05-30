package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// ═══════════════════════════════════════════════════════════════════════════
// Splits management
// ═══════════════════════════════════════════════════════════════════════════

// ListSplits — GET /api/v1/orders/{id}/splits.
func (h *OrdersHandler) ListSplits(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListSplits(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList(rows, ""))
}

// SplitEqual — POST /api/v1/orders/{id}/splits/equal.
func (h *OrdersHandler) SplitEqual(w http.ResponseWriter, r *http.Request) {
	var in service.SplitEqualInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.SplitEqual(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// SplitByItems — POST /api/v1/orders/{id}/splits/by-items.
func (h *OrdersHandler) SplitByItems(w http.ResponseWriter, r *http.Request) {
	var in service.SplitByItemsInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.SplitByItems(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// PaySplit — POST /api/v1/splits/{split_id}/pay.
func (h *OrdersHandler) PaySplit(w http.ResponseWriter, r *http.Request) {
	var in service.PaySplitInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.PaySplit(r.Context(), chi.URLParam(r, "split_id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// CancelSplits — POST /api/v1/orders/{id}/splits/cancel.
func (h *OrdersHandler) CancelSplits(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.CancelSplits(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// CheckAndClose — POST /api/v1/orders/{id}/check-and-close.
func (h *OrdersHandler) CheckAndClose(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.CheckAndClose(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// ═══════════════════════════════════════════════════════════════════════════
// Voids
// ═══════════════════════════════════════════════════════════════════════════

// ListVoidsByOrder — GET /api/v1/orders/{id}/voids.
func (h *OrdersHandler) ListVoidsByOrder(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListVoidsByOrder(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList(rows, ""))
}

// ListVoids — GET /api/v1/voids?order_ids=id1,id2.
func (h *OrdersHandler) ListVoids(w http.ResponseWriter, r *http.Request) {
	idsParam := queryString(r, "order_ids")
	var ids []string
	if idsParam != "" {
		for _, p := range strings.Split(idsParam, ",") {
			p = strings.TrimSpace(p)
			if p != "" {
				ids = append(ids, p)
			}
		}
	}
	rows, err := h.svc.ListVoidsByOrders(r.Context(), ids)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList(rows, ""))
}

// CreateVoid — POST /api/v1/voids.
func (h *OrdersHandler) CreateVoid(w http.ResponseWriter, r *http.Request) {
	var in service.CreateVoidInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	v, err := h.svc.CreateVoid(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, v)
}

// ═══════════════════════════════════════════════════════════════════════════
// Item lifecycle
// ═══════════════════════════════════════════════════════════════════════════

// CancelItem — POST /api/v1/orders/{id}/items/{itemId}/cancel.
func (h *OrdersHandler) CancelItem(w http.ResponseWriter, r *http.Request) {
	var in service.CancelItemInput
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			respond.BadRequest(w, "invalid JSON body")
			return
		}
	}
	item, err := h.svc.CancelItem(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "itemId"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, item)
}

// MarkServed — POST /api/v1/orders/{id}/items/{itemId}/served.
func (h *OrdersHandler) MarkServed(w http.ResponseWriter, r *http.Request) {
	item, err := h.svc.MarkItemServed(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "itemId"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, item)
}

// SetItemNote — PATCH /api/v1/orders/{id}/items/{itemId}/note.
func (h *OrdersHandler) SetItemNote(w http.ResponseWriter, r *http.Request) {
	var in service.SetItemNoteInput
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			respond.BadRequest(w, "invalid JSON body")
			return
		}
	}
	item, err := h.svc.SetItemNote(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "itemId"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, item)
}

// PrintPreBill — POST /api/v1/orders/{id}/print-pre-bill.
func (h *OrdersHandler) PrintPreBill(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.PrintPreBill(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// UnmarkServed — DELETE /api/v1/orders/{id}/items/{itemId}/served.
func (h *OrdersHandler) UnmarkServed(w http.ResponseWriter, r *http.Request) {
	item, err := h.svc.UnmarkItemServed(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "itemId"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, item)
}

// ClaimPrint — POST /api/v1/orders/{id}/items/{itemId}/claim-print.
func (h *OrdersHandler) ClaimPrint(w http.ResponseWriter, r *http.Request) {
	var in service.ClaimPrintInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.ClaimPrint(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "itemId"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// ReleasePrint — POST /api/v1/orders/{id}/items/{itemId}/release-print.
func (h *OrdersHandler) ReleasePrint(w http.ResponseWriter, r *http.Request) {
	item, err := h.svc.ReleasePrint(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "itemId"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, item)
}

// ClaimCancelPrint — POST /api/v1/orders/{id}/items/{itemId}/claim-cancel-print.
func (h *OrdersHandler) ClaimCancelPrint(w http.ResponseWriter, r *http.Request) {
	var in service.ClaimPrintInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.ClaimCancelPrint(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "itemId"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// ReleaseCancelPrint — POST /api/v1/orders/{id}/items/{itemId}/release-cancel-print.
func (h *OrdersHandler) ReleaseCancelPrint(w http.ResponseWriter, r *http.Request) {
	item, err := h.svc.ReleaseCancelPrint(r.Context(), chi.URLParam(r, "id"), chi.URLParam(r, "itemId"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, item)
}

// ═══════════════════════════════════════════════════════════════════════════
// Order operations
// ═══════════════════════════════════════════════════════════════════════════

// Reopen — POST /api/v1/orders/{id}/reopen.
func (h *OrdersHandler) Reopen(w http.ResponseWriter, r *http.Request) {
	var in service.ReopenOrderInput
	if r.ContentLength > 0 {
		if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
			respond.BadRequest(w, "invalid JSON body")
			return
		}
	}
	o, err := h.svc.Reopen(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, o)
}

// MoveTable — POST /api/v1/orders/{id}/table.
func (h *OrdersHandler) MoveTable(w http.ResponseWriter, r *http.Request) {
	var in service.MoveTableInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	o, err := h.svc.MoveTable(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, o)
}

// ═══════════════════════════════════════════════════════════════════════════
// Background jobs
// ═══════════════════════════════════════════════════════════════════════════

// AutoReadyCheck — POST /api/v1/orders/auto-ready/check.
func (h *OrdersHandler) AutoReadyCheck(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.AutoReadyCheck(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// CleanupOrphans — POST /api/v1/admin/cleanup/orphan-orders.
func (h *OrdersHandler) CleanupOrphans(w http.ResponseWriter, r *http.Request) {
	res, err := h.svc.CleanupOrphanOrders(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}
