package handlers

// Backup handlers — ручной бэкап/восстановление БД через UI.

import (
	"io"
	"net/http"
	"os"
	"path/filepath"

	"github.com/go-chi/chi/v5"

	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/respond"
)

type BackupHandler struct {
	svc *service.BackupService
}

func NewBackup(svc *service.BackupService) *BackupHandler { return &BackupHandler{svc: svc} }

// Create — POST /api/v1/backup/create.
func (h *BackupHandler) Create(w http.ResponseWriter, r *http.Request) {
	file, err := h.svc.Create(r.Context())
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusCreated, file)
}

// List — GET /api/v1/backup/list.
func (h *BackupHandler) List(w http.ResponseWriter, r *http.Request) {
	files, err := h.svc.List()
	if err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"data": files})
}

// Download — GET /api/v1/backup/download/{name}.
func (h *BackupHandler) Download(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	fpath, err := h.svc.Path(name)
	if err != nil {
		respond.Error(w, err)
		return
	}
	f, err := os.Open(fpath)
	if err != nil {
		respond.Error(w, err)
		return
	}
	defer f.Close()
	fi, _ := f.Stat()
	w.Header().Set("Content-Type", "application/octet-stream")
	w.Header().Set("Content-Disposition", `attachment; filename="`+filepath.Base(fpath)+`"`)
	if fi != nil {
		w.Header().Set("Content-Length", itoaInt64(fi.Size()))
	}
	_, _ = io.Copy(w, f)
}

// Delete — DELETE /api/v1/backup/{name}.
func (h *BackupHandler) Delete(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if err := h.svc.Delete(name); err != nil {
		respond.Error(w, err)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}

// RestoreUpload — POST /api/v1/backup/restore (multipart "file").
// Загружает .dump с диска юзера → pg_restore.
func (h *BackupHandler) RestoreUpload(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(200 << 20); err != nil { // 200 MB cap
		respond.BadRequest(w, "expected multipart/form-data with file field")
		return
	}
	src, _, err := r.FormFile("file")
	if err != nil {
		respond.BadRequest(w, "file field 'file' is required")
		return
	}
	defer src.Close()

	// Сохраняем во временный файл (pg_restore работает с путём, не stdin).
	tmp, err := os.CreateTemp("", "restos-restore-*.dump")
	if err != nil {
		respond.Error(w, err)
		return
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	if _, err := io.Copy(tmp, src); err != nil {
		tmp.Close()
		respond.Error(w, err)
		return
	}
	tmp.Close()

	if err := h.svc.Restore(r.Context(), tmpPath); err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"restored": true})
}

// RestoreExisting — POST /api/v1/backup/{name}/restore.
// Восстановление из уже существующего файла в backups/ (откат на бэкап из списка).
func (h *BackupHandler) RestoreExisting(w http.ResponseWriter, r *http.Request) {
	name := chi.URLParam(r, "name")
	if err := h.svc.RestoreFromExisting(r.Context(), name); err != nil {
		respond.Error(w, err)
		return
	}
	respond.JSON(w, http.StatusOK, map[string]any{"restored": true})
}

func itoaInt64(v int64) string {
	if v == 0 {
		return "0"
	}
	neg := v < 0
	if neg {
		v = -v
	}
	buf := make([]byte, 0, 20)
	for v > 0 {
		buf = append([]byte{byte('0' + v%10)}, buf...)
		v /= 10
	}
	if neg {
		buf = append([]byte{'-'}, buf...)
	}
	return string(buf)
}
