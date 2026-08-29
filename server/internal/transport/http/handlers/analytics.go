package handlers

// Analytics handlers — серверные аггрегаты для /analytics/* экранов.
// Все принимают ?from&to (RFC3339), возвращают JSON.

import (
	"net/http"
	"strconv"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type AnalyticsHandler struct {
	svc *service.AnalyticsService
}

func NewAnalytics(svc *service.AnalyticsService) *AnalyticsHandler {
	return &AnalyticsHandler{svc: svc}
}

func (h *AnalyticsHandler) ABCMenu(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.ABCMenu(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *AnalyticsHandler) Weekday(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.Weekday(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *AnalyticsHandler) PeakHours(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.PeakHours(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// KitchenStages — GET /api/v1/analytics/kitchen-stage-report. Время блюда по
// станциям/стадиям (очередь/готовка/ожидание выдачи) + сравнение с тех-картой.
func (h *AnalyticsHandler) KitchenStages(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.KitchenStages(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *AnalyticsHandler) Waiters(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.Waiters(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *AnalyticsHandler) Tables(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.Tables(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *AnalyticsHandler) FoodCost(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.FoodCost(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// SalesReport — GET /api/v1/analytics/sales-report (Н21).
func (h *AnalyticsHandler) SalesReport(w http.ResponseWriter, r *http.Request) {
	period, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	f := service.SalesReportFilter{PeriodFilter: period, OrderType: queryString(r, "order_type")}
	out, err := h.svc.SalesReport(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// CancellationsReport — GET /api/v1/analytics/cancellations.
func (h *AnalyticsHandler) CancellationsReport(w http.ResponseWriter, r *http.Request) {
	period, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	f := service.CancellationFilter{PeriodFilter: period}
	if v := queryString(r, "limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Limit = n
		}
	}
	if v := queryString(r, "offset"); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			f.Offset = n
		}
	}
	out, err := h.svc.CancellationsReport(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *AnalyticsHandler) IngredientStockValue(w http.ResponseWriter, r *http.Request) {
	limit := 10
	if v := queryString(r, "limit"); v != "" {
		if n, err := strconv.Atoi(v); err == nil && n > 0 && n <= 200 {
			limit = n
		}
	}
	out, err := h.svc.IngredientStockValue(r.Context(), limit)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *AnalyticsHandler) Forecast(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.Forecast(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *AnalyticsHandler) ABCInventory(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.ABCInventory(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

func (h *AnalyticsHandler) FoodCostMonthly(w http.ResponseWriter, r *http.Request) {
	f, err := parsePeriod(r)
	if err != nil {
		respond.BadRequest(w, err.Error())
		return
	}
	out, err := h.svc.FoodCostMonthly(r.Context(), f)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}
