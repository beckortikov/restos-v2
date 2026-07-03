package handlers

import (
	"encoding/json"
	"net/http"
	"strings"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// KDSHandler — кухонный дисплей (per-dish доска).
type KDSHandler struct {
	svc *service.KDSService
}

func NewKDS(svc *service.KDSService) *KDSHandler { return &KDSHandler{svc: svc} }

// List — GET /api/v1/kds/items.
// Query: stations=hot_kitchen,grill (CSV, пусто = все), status=pending,cooking
// (CSV, пусто = в работе). Возвращает {data:[KDSItem]} отсортированные по времени.
func (h *KDSHandler) List(w http.ResponseWriter, r *http.Request) {
	stations := csvParam(r, "stations")
	statuses := csvParam(r, "status")
	items, err := h.svc.ListItems(r.Context(), stations, statuses)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"data": items})
}

// Stations — GET /api/v1/kds/stations. Станции ресторана для настройки дисплея.
func (h *KDSHandler) Stations(w http.ResponseWriter, r *http.Request) {
	stations, err := h.svc.ListStations(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"data": stations})
}

// SetStatus — POST /api/v1/kds/items/{id}/status.
// Body: {"status":"cooking"}. Переводит блюдо в статус (кнопка на карточке).
func (h *KDSHandler) SetStatus(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var in struct {
		Status string `json:"status"`
	}
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	item, err := h.svc.SetItemStatus(r.Context(), id, in.Status)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, item)
}

// csvParam читает CSV query-параметр в срез непустых значений.
func csvParam(r *http.Request, key string) []string {
	raw := strings.TrimSpace(r.URL.Query().Get(key))
	if raw == "" {
		return nil
	}
	var out []string
	for _, p := range strings.Split(raw, ",") {
		if v := strings.TrimSpace(p); v != "" {
			out = append(out, v)
		}
	}
	return out
}
