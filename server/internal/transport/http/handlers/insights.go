package handlers

// Insights handler — «Инсайты»: ранжированные действия (кросс-аналитика).

import (
	"net/http"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type InsightsHandler struct {
	svc *service.InsightsService
}

func NewInsights(svc *service.InsightsService) *InsightsHandler {
	return &InsightsHandler{svc: svc}
}

// Insights — GET /api/v1/analytics/insights?from=&to=.
func (h *InsightsHandler) Insights(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.Insights(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}
