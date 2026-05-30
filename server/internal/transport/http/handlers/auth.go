// Package handlers — HTTP-хендлеры restos-server.
//
// Конвенция:
//   - тонкие, без бизнес-логики (она в internal/service);
//   - парсят query/body, дёргают сервис, отдают через respond;
//   - не работают с *gorm.DB напрямую — только через сервис или repo.
package handlers

import (
	"encoding/json"
	"errors"
	"net/http"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/middleware"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// AuthHandler собирает endpoint-ы /api/v1/auth/*.
type AuthHandler struct {
	svc *service.AuthService
	db  *gorm.DB
}

func NewAuth(svc *service.AuthService, db *gorm.DB) *AuthHandler {
	return &AuthHandler{svc: svc, db: db}
}

type loginReq struct {
	RestaurantID string `json:"restaurant_id"`
	PIN          string `json:"pin"`
}

// loginUser — публичная инфа о юзере для логин-ответа.
// Зеркалит Kotlin-DTO PinLoginResponse.UserDto в android-kotlin/.
type loginUser struct {
	ID          string   `json:"id"`
	Username    string   `json:"username"`
	FullName    string   `json:"full_name"`
	Role        string   `json:"role"`
	Permissions []string `json:"permissions"`
}

// loginRestaurant — публичная инфа о ресторане для логин-ответа.
// Зеркалит Kotlin-DTO PinLoginResponse.RestaurantDto.
type loginRestaurant struct {
	ID   string `json:"id"`
	Name string `json:"name"`
}

type loginResp struct {
	Token      string              `json:"token"`
	Session    service.SessionInfo `json:"session"`
	User       loginUser           `json:"user"`
	Restaurant loginRestaurant     `json:"restaurant"`
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

	lu := loginUser{
		ID:          user.ID,
		Permissions: []string{},
	}
	if user.Username != nil {
		lu.Username = *user.Username
	}
	if user.Name != nil {
		lu.FullName = *user.Name
	}
	if user.Role != nil {
		lu.Role = *user.Role
	}

	// Restaurant lookup для name. Если не нашли — отдаём id с пустым name
	// (Kotlin позволяет это; Electron-фронт это поле игнорирует).
	lr := loginRestaurant{ID: req.RestaurantID}
	if h.db != nil {
		var rest models.Restaurant
		if err := h.db.WithContext(r.Context()).
			Where("id = ?", req.RestaurantID).
			First(&rest).Error; err != nil {
			if !errors.Is(err, gorm.ErrRecordNotFound) {
				// не критично для логина — лог не светим юзеру
			}
		} else {
			lr.Name = rest.Name
		}
	}

	respond.JSON(w, http.StatusOK, loginResp{
		Token:      tok,
		Session:    info,
		User:       lu,
		Restaurant: lr,
	})
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
