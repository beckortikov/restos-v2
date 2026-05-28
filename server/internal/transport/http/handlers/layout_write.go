package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// ─── Zones write ───────────────────────────────────────────────────────────

type ZonesWriteHandler struct{ svc *service.ZonesWriteService }

func NewZonesWrite(svc *service.ZonesWriteService) *ZonesWriteHandler {
	return &ZonesWriteHandler{svc: svc}
}

func (h *ZonesWriteHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.ZoneInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	z, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, z)
}

func (h *ZonesWriteHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.ZoneInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	z, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, z)
}

func (h *ZonesWriteHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Tables write ──────────────────────────────────────────────────────────

type TablesWriteHandler struct{ svc *service.TablesWriteService }

func NewTablesWrite(svc *service.TablesWriteService) *TablesWriteHandler {
	return &TablesWriteHandler{svc: svc}
}

func (h *TablesWriteHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.TableInput
	if !decodeBody(r, &in) {
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

func (h *TablesWriteHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.TableInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}

func (h *TablesWriteHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *TablesWriteHandler) SetStatus(w http.ResponseWriter, r *http.Request) {
	var in service.TableInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.SetStatus(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}

func (h *TablesWriteHandler) AssignWaiter(w http.ResponseWriter, r *http.Request) {
	var in service.AssignWaiterInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.AssignWaiter(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}

func (h *TablesWriteHandler) OpenForOrder(w http.ResponseWriter, r *http.Request) {
	var in service.OpenForOrderInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.OpenForOrder(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}

func (h *TablesWriteHandler) Merge(w http.ResponseWriter, r *http.Request) {
	var in service.MergeInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Merge(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *TablesWriteHandler) Unmerge(w http.ResponseWriter, r *http.Request) {
	t, err := h.svc.Unmerge(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}

func (h *TablesWriteHandler) CleanupStuck(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.CleanupStuck(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}
