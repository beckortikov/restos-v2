package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// NetworkHandler — сетевые справочники multi-branch (ADR-003, Фаза 1):
// филиалы, общий каталог номенклатуры, привязка ингредиентов.
type NetworkHandler struct {
	svc *service.NetworkService
}

func NewNetwork(svc *service.NetworkService) *NetworkHandler {
	return &NetworkHandler{svc: svc}
}

// ListBranches — GET /api/v1/network/branches.
func (h *NetworkHandler) ListBranches(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListBranches(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.Branch](rows, ""))
}

// Summary — GET /api/v1/network/summary?from=&to=. Сводка выручки владельцу.
func (h *NetworkHandler) Summary(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Summary(r.Context(), r.URL.Query().Get("from"), r.URL.Query().Get("to"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// ListNetworkMenu — GET /api/v1/network/menu.
func (h *NetworkHandler) ListNetworkMenu(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListNetworkMenu(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.NetworkMenuItem](rows, ""))
}

// CreateNetworkMenuItem — POST /api/v1/network/menu.
func (h *NetworkHandler) CreateNetworkMenuItem(w http.ResponseWriter, r *http.Request) {
	var in service.NetworkMenuInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	m, err := h.svc.CreateNetworkMenuItem(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, m)
}

// UpdateNetworkMenuItem — PATCH /api/v1/network/menu/{id}.
func (h *NetworkHandler) UpdateNetworkMenuItem(w http.ResponseWriter, r *http.Request) {
	var in service.NetworkMenuInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	m, err := h.svc.UpdateNetworkMenuItem(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, m)
}

// CreateNetwork — POST /api/v1/network. Заводит сеть, текущий ресторан —
// центральный склад.
func (h *NetworkHandler) CreateNetwork(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Name string `json:"name"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	acc, err := h.svc.CreateNetwork(r.Context(), in.Name)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, acc)
}

// SetBranchKind — POST /api/v1/network/branches/{id}/kind.
func (h *NetworkHandler) SetBranchKind(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Kind string `json:"kind"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	if err := h.svc.SetBranchKind(r.Context(), chi.URLParam(r, "id"), in.Kind); err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]string{"status": "ok"})
}

// ListNomenclature — GET /api/v1/nomenclature.
func (h *NetworkHandler) ListNomenclature(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListNomenclature(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Nomenclature](rows, ""))
}

// CreateNomenclature — POST /api/v1/nomenclature.
func (h *NetworkHandler) CreateNomenclature(w http.ResponseWriter, r *http.Request) {
	var in service.CreateNomenclatureInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	n, err := h.svc.CreateNomenclature(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, n)
}

// LinkIngredient — POST /api/v1/stock/ingredients/{id}/nomenclature.
func (h *NetworkHandler) LinkIngredient(w http.ResponseWriter, r *http.Request) {
	var in struct {
		NomenclatureID string `json:"nomenclature_id"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	if err := h.svc.LinkIngredient(r.Context(), chi.URLParam(r, "id"), in.NomenclatureID); err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]string{"status": "linked"})
}
