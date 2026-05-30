package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/timeutil"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// generic JSON-decode для PATCH-input'ов.
func decodeBody(r *http.Request, dst any) bool {
	return json.NewDecoder(r.Body).Decode(dst) == nil
}

// ─── Assets ────────────────────────────────────────────────────────────────

type AssetsHandler struct{ svc *service.AssetsService }

func NewAssets(svc *service.AssetsService) *AssetsHandler { return &AssetsHandler{svc: svc} }

func (h *AssetsHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Asset](rows, ""))
}
func (h *AssetsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.AssetInput
	if !decodeBody(r, &in) {
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
func (h *AssetsHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.AssetInput
	if !decodeBody(r, &in) {
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
func (h *AssetsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Liabilities ───────────────────────────────────────────────────────────

type LiabilitiesHandler struct{ svc *service.LiabilitiesService }

func NewLiabilities(svc *service.LiabilitiesService) *LiabilitiesHandler {
	return &LiabilitiesHandler{svc: svc}
}

func (h *LiabilitiesHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Liability](rows, ""))
}
func (h *LiabilitiesHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.LiabilityInput
	if !decodeBody(r, &in) {
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
func (h *LiabilitiesHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.LiabilityInput
	if !decodeBody(r, &in) {
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
func (h *LiabilitiesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── EquityEntries ─────────────────────────────────────────────────────────

type EquityHandler struct{ svc *service.EquityService }

func NewEquity(svc *service.EquityService) *EquityHandler { return &EquityHandler{svc: svc} }

func (h *EquityHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.EquityEntry](rows, ""))
}
func (h *EquityHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.EquityInput
	if !decodeBody(r, &in) {
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
func (h *EquityHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.EquityInput
	if !decodeBody(r, &in) {
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
func (h *EquityHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── BudgetLines ───────────────────────────────────────────────────────────

type BudgetHandler struct{ svc *service.BudgetService }

func NewBudget(svc *service.BudgetService) *BudgetHandler { return &BudgetHandler{svc: svc} }

func (h *BudgetHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context(), queryString(r, "period"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.BudgetLine](rows, ""))
}
func (h *BudgetHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.BudgetInput
	if !decodeBody(r, &in) {
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
func (h *BudgetHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.BudgetInput
	if !decodeBody(r, &in) {
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
func (h *BudgetHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── TimeEntries ───────────────────────────────────────────────────────────

type TimeEntriesHandler struct{ svc *service.TimeEntriesService }

func NewTimeEntries(svc *service.TimeEntriesService) *TimeEntriesHandler {
	return &TimeEntriesHandler{svc: svc}
}

func (h *TimeEntriesHandler) List(w http.ResponseWriter, r *http.Request) {
	var f service.TimeEntriesFilter
	f.UserID = queryString(r, "user_id")
	if v := queryString(r, "from"); v != "" {
		t, err := timeutil.ParseLooseRFC3339(v)
		if err != nil {
			respond.BadRequest(w, "bad ?from")
			return
		}
		f.From = &t
	}
	if v := queryString(r, "to"); v != "" {
		t, err := timeutil.ParseLooseRFC3339(v)
		if err != nil {
			respond.BadRequest(w, "bad ?to")
			return
		}
		f.To = &t
	}
	rows, err := h.svc.List(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.TimeEntry](rows, ""))
}
func (h *TimeEntriesHandler) ClockIn(w http.ResponseWriter, r *http.Request) {
	var in service.TimeEntryInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.ClockIn(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, t)
}
func (h *TimeEntriesHandler) ClockOut(w http.ResponseWriter, r *http.Request) {
	var in service.TimeEntryInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.ClockOut(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}
func (h *TimeEntriesHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── ModifierGroups ────────────────────────────────────────────────────────

type ModifierGroupsHandler struct {
	svc *service.ModifierGroupsService
}

func NewModifierGroups(svc *service.ModifierGroupsService) *ModifierGroupsHandler {
	return &ModifierGroupsHandler{svc: svc}
}

func (h *ModifierGroupsHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context(), queryString(r, "menu_item_id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.ModifierGroup](rows, ""))
}
func (h *ModifierGroupsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.ModifierGroupInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	g, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, g)
}
func (h *ModifierGroupsHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.ModifierGroupInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	g, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, g)
}
func (h *ModifierGroupsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Modifiers ─────────────────────────────────────────────────────────────

type ModifiersHandler struct{ svc *service.ModifiersService }

func NewModifiers(svc *service.ModifiersService) *ModifiersHandler {
	return &ModifiersHandler{svc: svc}
}

func (h *ModifiersHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context(), queryString(r, "group_id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Modifier](rows, ""))
}
func (h *ModifiersHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.ModifierInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	m, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, m)
}
func (h *ModifiersHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.ModifierInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	m, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, m)
}
func (h *ModifiersHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── TechCardLines ─────────────────────────────────────────────────────────

type TechCardsHandler struct{ svc *service.TechCardsService }

func NewTechCards(svc *service.TechCardsService) *TechCardsHandler {
	return &TechCardsHandler{svc: svc}
}

func (h *TechCardsHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context(), queryString(r, "menu_item_id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.TechCardLine](rows, ""))
}
func (h *TechCardsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.TechCardLineInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	l, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, l)
}
func (h *TechCardsHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.TechCardLineInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	l, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, l)
}
func (h *TechCardsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── SemiFinished ──────────────────────────────────────────────────────────

type SemiFinishedHandler struct{ svc *service.SemiFinishedService }

func NewSemiFinished(svc *service.SemiFinishedService) *SemiFinishedHandler {
	return &SemiFinishedHandler{svc: svc}
}

func (h *SemiFinishedHandler) ListTypes(w http.ResponseWriter, r *http.Request) {
	if queryString(r, "include") == "recipe" {
		rows, err := h.svc.ListTypesWithRecipe(r.Context())
		if err != nil {
			respond.Error(w, err)
			return
		}
		respond.JSON(w, http.StatusOK, makeList[service.SemiTypeWithRecipe](rows, ""))
		return
	}
	rows, err := h.svc.ListTypes(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.SemiFinishedType](rows, ""))
}

func (h *SemiFinishedHandler) GetType(w http.ResponseWriter, r *http.Request) {
	includeRecipe := queryString(r, "include") == "recipe"
	out, err := h.svc.GetType(r.Context(), chi.URLParam(r, "id"), includeRecipe)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}
func (h *SemiFinishedHandler) CreateType(w http.ResponseWriter, r *http.Request) {
	var in service.SemiTypeInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.CreateType(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, t)
}
func (h *SemiFinishedHandler) PatchType(w http.ResponseWriter, r *http.Request) {
	var in service.SemiTypeInput
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	t, err := h.svc.PatchType(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, t)
}
func (h *SemiFinishedHandler) DeleteType(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.DeleteType(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
func (h *SemiFinishedHandler) ListStock(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.ListStock(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.SemiFinishedStock](rows, ""))
}
