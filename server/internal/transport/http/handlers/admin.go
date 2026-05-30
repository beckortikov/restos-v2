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

// ─── Users ─────────────────────────────────────────────────────────────────

type UsersHandler struct{ svc *service.UsersService }

func NewUsers(svc *service.UsersService) *UsersHandler { return &UsersHandler{svc: svc} }

func (h *UsersHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context(), service.UsersFilter{
		RestaurantID: queryString(r, "restaurant_id"),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.User](rows, ""))
}

// ValidatePIN — POST /api/v1/users/validate-pin.
// body: {"pin": "1234", "restaurant_id"?: string} → user (без PIN/password).
// 404 если не найден.
func (h *UsersHandler) ValidatePIN(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PIN          string `json:"pin"`
		RestaurantID string `json:"restaurant_id,omitempty"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	u, err := h.svc.ValidatePIN(r.Context(), in.RestaurantID, in.PIN)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, u)
}

// GeneratePIN — POST /api/v1/users/generate-pin.
// body: {"restaurant_id"?: string} → {"pin": "1234"}.
func (h *UsersHandler) GeneratePIN(w http.ResponseWriter, r *http.Request) {
	var in struct {
		RestaurantID string `json:"restaurant_id,omitempty"`
	}
	// Тело может быть пустым — игнорируем ошибку декодирования.
	_ = json.NewDecoder(r.Body).Decode(&in)
	pin, err := h.svc.GeneratePIN(r.Context(), in.RestaurantID)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]string{"pin": pin})
}
func (h *UsersHandler) Get(w http.ResponseWriter, r *http.Request) {
	u, err := h.svc.Get(r.Context(), chi.URLParam(r, "id"))
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, u)
}
func (h *UsersHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.UserInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	u, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, u)
}
func (h *UsersHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.UserInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	u, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, u)
}
func (h *UsersHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Customers ─────────────────────────────────────────────────────────────

type CustomersHandler struct{ svc *service.CustomersService }

func NewCustomers(svc *service.CustomersService) *CustomersHandler {
	return &CustomersHandler{svc: svc}
}

func (h *CustomersHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, next, err := h.svc.List(r.Context(), service.CustomersFilter{
		Query: queryString(r, "q"),
		Page:  parsePage(r),
	})
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Customer](rows, next))
}
func (h *CustomersHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.CustomerInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	c, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, c)
}
func (h *CustomersHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.CustomerInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	c, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, c)
}

// IncrementStats — POST /api/v1/customers/{id}/stats.
func (h *CustomersHandler) IncrementStats(w http.ResponseWriter, r *http.Request) {
	var in service.CustomerStatsInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	c, err := h.svc.IncrementStats(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, c)
}

func (h *CustomersHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Suppliers ─────────────────────────────────────────────────────────────

type SuppliersHandler struct{ svc *service.SuppliersService }

func NewSuppliers(svc *service.SuppliersService) *SuppliersHandler {
	return &SuppliersHandler{svc: svc}
}

func (h *SuppliersHandler) List(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.List(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[models.Supplier](rows, ""))
}
func (h *SuppliersHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.SupplierInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	s, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, s)
}
func (h *SuppliersHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.SupplierInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	s, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, s)
}
func (h *SuppliersHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Reservations ──────────────────────────────────────────────────────────

type ReservationsHandler struct{ svc *service.ReservationsService }

func NewReservations(svc *service.ReservationsService) *ReservationsHandler {
	return &ReservationsHandler{svc: svc}
}

func (h *ReservationsHandler) List(w http.ResponseWriter, r *http.Request) {
	var f service.ReservationsFilter
	f.Status = queryString(r, "status")
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
	respond.JSON(w, http.StatusOK, makeList[models.Reservation](rows, ""))
}
func (h *ReservationsHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.ReservationInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, res)
}
func (h *ReservationsHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.ReservationInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.Patch(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// PatchStatus — POST /api/v1/reservations/{id}/status.
func (h *ReservationsHandler) PatchStatus(w http.ResponseWriter, r *http.Request) {
	var in service.ReservationStatusInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.PatchStatus(r.Context(), chi.URLParam(r, "id"), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

func (h *ReservationsHandler) Delete(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.Delete(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// ─── Restaurant ────────────────────────────────────────────────────────────

type RestaurantHandler struct{ svc *service.RestaurantService }

func NewRestaurant(svc *service.RestaurantService) *RestaurantHandler {
	return &RestaurantHandler{svc: svc}
}

func (h *RestaurantHandler) Get(w http.ResponseWriter, r *http.Request) {
	rest, err := h.svc.Get(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, rest)
}
func (h *RestaurantHandler) Patch(w http.ResponseWriter, r *http.Request) {
	var in service.RestaurantInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	rest, err := h.svc.Patch(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, rest)
}
