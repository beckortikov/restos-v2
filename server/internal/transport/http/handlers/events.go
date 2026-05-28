package handlers

import (
	"net/http"

	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
	"github.com/restos/restos-v4/server/internal/transport/sse"
)

type EventsHandler struct {
	hub *sse.Hub
}

func NewEvents(hub *sse.Hub) *EventsHandler { return &EventsHandler{hub: hub} }

// Stream — GET /api/v1/events. Long-poll SSE.
// Требует Auth middleware (берёт restaurant_id из context'а).
func (h *EventsHandler) Stream(w http.ResponseWriter, r *http.Request) {
	rid, ok := tenant.RestaurantID(r.Context())
	if !ok {
		respond.Unauthorized(w, "")
		return
	}
	h.hub.ServeHTTP(w, r, rid)
}
