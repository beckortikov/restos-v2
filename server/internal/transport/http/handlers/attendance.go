package handlers

import (
	"net/http"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

// ─── Attendance — терминал учёта рабочего времени (:checkin) ────────────────

type AttendanceHandler struct {
	svc    *service.AttendanceService
	photos *service.AttendancePhotoStore
}

func NewAttendance(svc *service.AttendanceService, photos *service.AttendancePhotoStore) *AttendanceHandler {
	return &AttendanceHandler{svc: svc, photos: photos}
}

// attendancePinReq — PIN всегда в ТЕЛЕ, никогда в query: строка запроса
// попадает в логи прокси и в историю, а это рабочий пароль сотрудника.
type attendancePinReq struct {
	PIN string `json:"pin"`
}

type attendancePunchReq struct {
	PIN    string `json:"pin"`
	Action string `json:"action"` // "in" | "out"
	// Photo — селфи в base64 (JPEG, ~640px). Необязательное: терминал без
	// камеры или без выданного разрешения продолжает отмечать людей.
	Photo string `json:"photo,omitempty"`
}

// Lookup — POST /api/v1/attendance/lookup.
func (h *AttendanceHandler) Lookup(w http.ResponseWriter, r *http.Request) {
	var in attendancePinReq
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.Lookup(r.Context(), in.PIN)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// Punch — POST /api/v1/attendance/punch.
func (h *AttendanceHandler) Punch(w http.ResponseWriter, r *http.Request) {
	var in attendancePunchReq
	if !decodeBody(r, &in) {
		respond.BadRequest(w, "invalid JSON body")
		return
	}
	res, err := h.svc.Punch(r.Context(), in.PIN, in.Action, in.Photo)
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, res)
}

// OnShift — GET /api/v1/attendance/on-shift.
func (h *AttendanceHandler) OnShift(w http.ResponseWriter, r *http.Request) {
	rows, err := h.svc.OnShift(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, makeList[service.AttendanceOnShiftRow](rows, ""))
}

// Photo — GET /api/v1/attendance/photo/{entry_id}?kind=in|out — оригинал
// снимка с диска. Отдаём как файл, а не base64 в JSON: браузер и Android
// кладут его прямо в <img>, и лишнего перекодирования не происходит.
func (h *AttendanceHandler) Photo(w http.ResponseWriter, r *http.Request) {
	kind := queryString(r, "kind")
	if kind == "" {
		kind = "in"
	}
	data, err := h.photos.Original(r.Context(), chi.URLParam(r, "entry_id"), kind)
	if err != nil {
		respond.Error(w, err)
		return
	}
	w.Header().Set("Content-Type", "image/jpeg")
	// Снимок неизменяем: тот же entry_id+kind всегда даёт тот же файл.
	w.Header().Set("Cache-Control", "private, max-age=86400")
	w.WriteHeader(http.StatusOK)
	_, _ = w.Write(data)
}
