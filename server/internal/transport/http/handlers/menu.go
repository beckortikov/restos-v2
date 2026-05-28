package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type MenuHandler struct {
	svc *service.MenuService
}

func NewMenu(svc *service.MenuService) *MenuHandler { return &MenuHandler{svc: svc} }

// menuItemsEnvelope — ответ /menu/items. Ingredient_prices всегда присутствует
// (пустая мапа — если не запрошены через ?include=ingredient_prices). Каждый
// item в Data — это MenuItemWithExtras с полем tech_card_lines (тоже всегда
// присутствует, []). Это убирает type-ветвление на фронте.
type menuItemsEnvelope struct {
	Data             []service.MenuItemWithExtras       `json:"data"`
	IngredientPrices map[string]service.IngredientPrice `json:"ingredient_prices"`
	NextCursor       string                             `json:"next_cursor,omitempty"`
}

// ListItems — GET /api/v1/menu/items.
// Query: limit, cursor, category, q, available=true, include=tech_cards,ingredient_prices.
func (h *MenuHandler) ListItems(w http.ResponseWriter, r *http.Request) {
	includeTC := false
	includeIP := false
	if inc := queryString(r, "include"); inc != "" {
		for _, p := range strings.Split(inc, ",") {
			switch strings.TrimSpace(p) {
			case "tech_cards":
				includeTC = true
			case "ingredient_prices":
				includeIP = true
			}
		}
	}
	res, err := h.svc.ListItems(r.Context(), service.MenuItemsFilter{
		Category:                queryString(r, "category"),
		Query:                   queryString(r, "q"),
		OnlyAvailable:           queryString(r, "available") == "true",
		IncludeTechCards:        includeTC,
		IncludeIngredientPrices: includeIP,
		Page:                    parsePage(r),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, menuItemsEnvelope{
		Data:             res.Items,
		IngredientPrices: res.IngredientPrices,
		NextCursor:       res.NextCursor,
	})
}

// ListCategories — GET /api/v1/menu/categories.
func (h *MenuHandler) ListCategories(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListCategories(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.MenuCategory](rows, ""))
}

// CreateItem — POST /api/v1/menu/items.
func (h *MenuHandler) CreateItem(w http.ResponseWriter, r *http.Request) {
	var in service.MenuItemInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	mi, err := h.svc.CreateItem(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, mi)
}

// PatchItem — PATCH /api/v1/menu/items/{id}.
func (h *MenuHandler) PatchItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in service.MenuItemInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	mi, err := h.svc.PatchItem(r.Context(), id, in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, mi)
}

// DeleteItem — DELETE /api/v1/menu/items/{id} (soft).
func (h *MenuHandler) DeleteItem(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.svc.SoftDeleteItem(r.Context(), id); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// CreateCategory — POST /api/v1/menu/categories.
func (h *MenuHandler) CreateCategory(w http.ResponseWriter, r *http.Request) {
	var in service.MenuCategoryInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	c, err := h.svc.CreateCategory(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, c)
}

// PatchCategory — PATCH /api/v1/menu/categories/{id}.
func (h *MenuHandler) PatchCategory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in service.MenuCategoryInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	c, err := h.svc.PatchCategory(r.Context(), id, in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, c)
}

// DeleteCategory — DELETE /api/v1/menu/categories/{id}.
func (h *MenuHandler) DeleteCategory(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if err := h.svc.DeleteCategory(r.Context(), id); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
