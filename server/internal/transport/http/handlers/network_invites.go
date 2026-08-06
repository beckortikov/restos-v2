package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// CreateInvite — POST /api/v1/network/invites (central, owner-only).
func (h *NetworkHandler) CreateInvite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Label     string `json:"label"`
		PublicURL string `json:"public_url"`
	}
	_ = json.NewDecoder(r.Body).Decode(&in)
	out, err := h.svc.CreateInvite(r.Context(), in.Label, in.PublicURL)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, out)
}

// ListInvites — GET /api/v1/network/invites (central, owner-only).
func (h *NetworkHandler) ListInvites(w http.ResponseWriter, r *http.Request) {
	out, err := h.svc.ListInvites(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.NetworkInviteOut](out, ""))
}

// RevokeInvite — DELETE /api/v1/network/invites/{id} (central, owner-only).
func (h *NetworkHandler) RevokeInvite(w http.ResponseWriter, r *http.Request) {
	if err := h.svc.RevokeInvite(r.Context(), chi.URLParam(r, "id")); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RedeemInvite — POST /api/v1/sync/pair. ПУБЛИЧНЫЙ (без auth — это и есть
// bootstrap доверия): вызывается филиалом server-to-server с кодом
// приглашения, отдаёт настоящий sync-токен+account_id.
func (h *NetworkHandler) RedeemInvite(w http.ResponseWriter, r *http.Request) {
	var in struct {
		Code           string `json:"code"`
		RestaurantID   string `json:"restaurant_id"`
		RestaurantName string `json:"restaurant_name"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.RedeemInvite(r.Context(), in.Code, in.RestaurantID, in.RestaurantName)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// JoinNetwork — POST /api/v1/network/pair (филиал, owner-only). Обменивает
// код приглашения на central на реальные sync-настройки и сохраняет их.
func (h *NetworkHandler) JoinNetwork(w http.ResponseWriter, r *http.Request) {
	var in struct {
		PairingCode string `json:"pairing_code"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.JoinNetwork(r.Context(), in.PairingCode)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}
