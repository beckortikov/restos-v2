package handlers

import (
	"encoding/json"
	"net/http"
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// SyncHandler — приём дельт на центральном узле (ADR-003, Фаза 2).
type SyncHandler struct {
	svc *service.SyncService
}

func NewSync(svc *service.SyncService) *SyncHandler {
	return &SyncHandler{svc: svc}
}

// Ingest — POST /api/v1/sync/ingest. Филиал пушит батч дельг sync_log (up-sync).
func (h *SyncHandler) Ingest(w http.ResponseWriter, r *http.Request) {
	var in service.IngestInput
	if err := json.NewDecoder(r.Body).Decode(&in); err != nil {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	out, err := h.svc.Ingest(r.Context(), in)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Pull — GET /api/v1/sync/pull?restaurant_id=X. Центральный узел отдаёт дельты,
// адресованные филиалу (down-sync): входящие sent-перемещения.
func (h *SyncHandler) Pull(w http.ResponseWriter, r *http.Request) {
	// mirror_since — курсор филиала по зеркальным расходам (Фаза Р): он сам
	// сообщает, что у него уже есть, иначе центр отдавал бы их вечно. Пустой
	// или неразбираемый параметр = «нет ничего, пришли всё» (так ведёт себя и
	// касса старой версии, которая его не шлёт).
	var mirrorSince *time.Time
	if v := r.URL.Query().Get("mirror_since"); v != "" {
		if ts, err := time.Parse(time.RFC3339Nano, v); err == nil {
			mirrorSince = &ts
		}
	}
	out, err := h.svc.PullFor(r.Context(), r.URL.Query().Get("restaurant_id"), mirrorSince)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}

// Backfill — POST /api/v1/sync/backfill. Ручная кнопка «Отправить всю
// историю на central» (Настройки → Синхронизация, owner-only — проверка
// внутри SyncService.Backfill). Вызывается на ФИЛИАЛЕ (не central): rid —
// текущий tenant запроса, тот же ресторан, чья история уходит.
func (h *SyncHandler) Backfill(w http.ResponseWriter, r *http.Request) {
	rid, err := tenant.MustRestaurantID(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	out, err := h.svc.Backfill(r.Context(), rid)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, out)
}
