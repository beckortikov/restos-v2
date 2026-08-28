package handlers

import (
	"encoding/json"
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/middleware"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// DeliveryRelayHandler — central пробивает заказ доставки ЗА филиал (091, см.
// service/delivery_relay.go). Create — обычная user-сессия (central-сторона),
// Pending/Ack — sync-токен (филиал), та же авторизация, что /sync/*.
type DeliveryRelayHandler struct {
	svc *service.DeliveryRelayService
}

func NewDeliveryRelay(svc *service.DeliveryRelayService) *DeliveryRelayHandler {
	return &DeliveryRelayHandler{svc: svc}
}

// Create — POST /api/v1/delivery-relay. Central создаёт заказ для филиала.
func (h *DeliveryRelayHandler) Create(w http.ResponseWriter, r *http.Request) {
	var in service.CreateDeliveryRelayInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	row, err := h.svc.Create(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, row)
}

// Pending — GET /api/v1/sync/delivery/pending?restaurant_id=X. Филиал тянет
// свои pending-заказы.
func (h *DeliveryRelayHandler) Pending(w http.ResponseWriter, r *http.Request) {
	restaurantID := r.URL.Query().Get("restaurant_id")
	rows, err := h.svc.ListPending(r.Context(), restaurantID)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"orders": rows})
}

// Ack — POST /api/v1/sync/delivery/{id}/ack. Филиал подтверждает результат
// материализации (delivered|failed).
func (h *DeliveryRelayHandler) Ack(w http.ResponseWriter, r *http.Request) {
	var in service.AckDeliveryRelayInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	// Личный sync-токен филиала (Фаза Г) сужает ack ТОЛЬКО его собственными
	// строками; легаси общий секрет узел не опознаёт (caller="") — тогда не
	// сужаем, как и в остальных /sync/* хендлерах (см. middleware.SyncAuth).
	caller, _ := middleware.SyncCallerID(r.Context())
	if err := h.svc.Ack(r.Context(), chi.URLParam(r, "id"), caller, in); err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"ok": true})
}
