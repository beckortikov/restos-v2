// Package handlers — HTTP-хендлеры restos-server.
//
// Конвенция:
//   - тонкие, без бизнес-логики (она в internal/service);
//   - парсят query/body, дёргают сервис, отдают через respond;
//   - не работают с *gorm.DB напрямую — только через сервис или repo.
package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/middleware"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// AuthHandler собирает endpoint-ы /api/v1/auth/*.
type AuthHandler struct {
	svc *service.AuthService
}

func NewAuth(svc *service.AuthService) *AuthHandler {
	return &AuthHandler{svc: svc}
}

type loginReq struct {
	RestaurantID string `json:"restaurant_id"`
	PIN          string `json:"pin"`
}

type loginResp struct {
	Token   string              `json:"token"`
	Session service.SessionInfo `json:"session"`
}

// Login — POST /api/v1/auth/login.
// Body: {"restaurant_id":"...","pin":"1234"}.
func (h *AuthHandler) Login(w http.ResponseWriter, r *http.Request) {
	var req loginReq
	if err := json.NewDecoder(r.Body).Decode(&req); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	tok, user, err := h.svc.LoginByPIN(r.Context(), req.RestaurantID, req.PIN)
	if err != nil {
		respond.Error(w, err)
		return
	}
	info := service.SessionInfo{
		UserID:       user.ID,
		RestaurantID: req.RestaurantID,
	}
	if user.Name != nil {
		info.UserName = *user.Name
	}
	if user.Role != nil {
		info.Role = *user.Role
	}
	respond.JSON(w, http.StatusOK, loginResp{Token: tok, Session: info})
}

// Logout — POST /api/v1/auth/logout. Требует валидный токен (Auth middleware).
func (h *AuthHandler) Logout(w http.ResponseWriter, r *http.Request) {
	tok := middleware.BearerFromRequest(r)
	if tok == "" {
		respond.Unauthorized(w, "")
		return
	}
	if err := h.svc.Logout(r.Context(), tok); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
