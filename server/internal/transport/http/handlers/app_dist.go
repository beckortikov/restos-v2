package handlers

// App-dist handler — раздача APK-приложений по LAN/QR + загрузка нового APK
// через настройки кассы (вариант C, см. service/app_dist.go). Один экземпляр
// хендлера на вариант (официант, закупщик): маршрут скачивания и имя файла
// приходят из сервиса.

import (
	"net/http"
	"os"
	"strings"
	"time"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type AppDistHandler struct {
	svc *service.AppDistService
}

func NewAppDist(svc *service.AppDistService) *AppDistHandler {
	return &AppDistHandler{svc: svc}
}

// Download — публичный GET <downloadPath> (без авторизации: телефон качает APK
// по QR ещё до логина).
func (h *AppDistHandler) Download(w http.ResponseWriter, r *http.Request) {
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
	name := h.svc.AttachmentName()
	w.Header().Set("Content-Type", "application/vnd.android.package-archive")
	w.Header().Set("Content-Disposition", `attachment; filename="`+name+`"`)
	modTime := time.Time{}
	if fi != nil {
		modTime = fi.ModTime()
	}
	// ServeContent — поддерживает Range (докачка) + Content-Length.
	http.ServeContent(w, r, name, modTime, f)
}

// Info — GET /api/v1/<variant>-app — состояние APK для UI кассы.
func (h *AppDistHandler) Info(w http.ResponseWriter, r *http.Request) {
	info, err := h.svc.Info()
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, info)
}

// Upload — POST /api/v1/<variant>-app (multipart "file") — загрузка нового APK.
func (h *AppDistHandler) Upload(w http.ResponseWriter, r *http.Request) {
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
