package handlers

// Waiter-app handler — раздача APK официанта по LAN/QR + загрузка нового APK
// через настройки кассы (вариант C, см. service/waiter_app.go).

import (
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type WaiterAppHandler struct {
	svc *service.WaiterAppService
}

func NewWaiterApp(svc *service.WaiterAppService) *WaiterAppHandler {
	return &WaiterAppHandler{svc: svc}
}

// Download — GET /download/waiter.apk (ПУБЛИЧНЫЙ, без авторизации: телефон
// официанта качает APK по QR ещё до логина).
func (h *WaiterAppHandler) Download(w http.ResponseWriter, r *http.Request) {
	p := h.svc.Path()
	if p == "" {
		respond.NotFound(w, "APK ещё не загружен")
		return
	}
	f, err := os.Open(p)
	if err != nil {
		if os.IsNotExist(err) {
			respond.NotFound(w, "APK ещё не загружен")
			return
		}
		respond.Error(w, err)
		return
	}
	defer f.Close()
	fi, _ := f.Stat()
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition", `attachment; filename="restos-waiter.apk"`)
	modTime := time.Time{}
	if fi != nil {
		modTime = fi.ModTime()
	}
	// ServeContent — поддерживает Range (докачка) + Content-Length.
	http.ServeContent(w, r, "restos-waiter.apk", modTime, f)
}

// Info — GET /api/v1/waiter-app — состояние APK для UI кассы.
func (h *WaiterAppHandler) Info(w http.ResponseWriter, r *http.Request) {
	info, err := h.svc.Info()
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, info)
}

// Upload — POST /api/v1/waiter-app (multipart "file") — загрузка нового APK.
func (h *WaiterAppHandler) Upload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(128 << 20); err != nil { // 128 MB cap
		respond.BadRequest(w, "ожидается multipart/form-data с полем file")
		return
	}
	src, hdr, err := r.FormFile("file")
	if err != nil {
		respond.BadRequest(w, "поле file обязательно")
		return
	}
	defer src.Close()
	name := hdr.Filename
	if !strings.HasSuffix(strings.ToLower(name), ".apk") {
		respond.BadRequest(w, "ожидается файл .apk")
		return
	}
	info, err := h.svc.Save(src, r.FormValue("version"), name, time.Now())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, info)
}
