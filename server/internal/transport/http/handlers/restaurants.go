package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type RestaurantsHandler struct{ svc *service.RestaurantsService }

func NewRestaurants(svc *service.RestaurantsService) *RestaurantsHandler {
	return &RestaurantsHandler{svc: svc}
}

func (h *RestaurantsHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Restaurant](rows, ""))
}

func (h *RestaurantsHandler) Get(w http.ResponseWriter, r *http.Request) {
	rest, err := h.svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, rest)
}

func (h *RestaurantsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.RestaurantCreateInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	rest, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, rest)
}

func (h *RestaurantsHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.RestaurantCreateInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	rest, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, rest)
}

func (h *RestaurantsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

func (h *RestaurantsHandler) ClearOperations(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.ClearOperations(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *RestaurantsHandler) ClearMenu(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.ClearMenu(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// SeedDemo — POST /api/v1/restaurants/{id}/seed?dataset=demo.
func (h *RestaurantsHandler) SeedDemo(w http.ResponseWriter, r *http.Request) {
	dataset := r.URL.Query().Get("dataset")
	if dataset == "" {
		dataset = "demo"
	}
	if dataset != "demo" {
		respond.BadRequest(w, "unsupported dataset")
		return
	}
	out, err := h.svc.SeedDemo(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *RestaurantsHandler) Stats(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.Stats(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}
