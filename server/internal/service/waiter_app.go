package service

// WaiterAppService — управление APK официанта, который раздаётся по LAN/QR.
//
// Вариант C: APK загружается менеджером через настройки кассы и хранится в
// userData (DataDir). Сервер отдаёт файл публично по /download/waiter.apk,
// телефон официанта качает его по QR. Обновление APK = новая загрузка, без
// пересборки приложения.

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"time"

	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
)

var errWaiterAppNotConfigured = apperrors.Wrap("VALIDATION", "хранилище APK не сконфигурировано", nil)

// DownloadPath — публичный путь скачивания APK (вне /api/v1, без авторизации).
const WaiterAppDownloadPath = "/download/waiter.apk"

type WaiterAppService struct {
	apkPath string // "" → не сконфигурировано (dev/тест без DataDir)
}

func NewWaiterAppService(apkPath string) *WaiterAppService {
	return &WaiterAppService{apkPath: apkPath}
}

// Path — абсолютный путь к файлу APK ("" если не сконфигурировано).
func (s *WaiterAppService) Path() string { return s.apkPath }

func (s *WaiterAppService) metaPath() string {
	if s.apkPath == "" {
		return ""
	}
	return s.apkPath + ".json"
}

// waiterAppMeta — метаданные загрузки (рядом с APK).
type waiterAppMeta struct {
	Version    string    `json:"version"`
	FileName   string    `json:"file_name"`
	SizeBytes  int64     `json:"size_bytes"`
	UploadedAt time.Time `json:"uploaded_at"`
}

// WaiterAppInfo — состояние APK для UI кассы.
type WaiterAppInfo struct {
	Available    bool       `json:"available"`
	Version      string     `json:"version"`
	FileName     string     `json:"file_name"`
	SizeBytes    int64      `json:"size_bytes"`
	UploadedAt   *time.Time `json:"uploaded_at"`
	DownloadPath string     `json:"download_path"`
}

// Info — текущее состояние APK (есть ли, версия, размер, дата).
func (s *WaiterAppService) Info() (*WaiterAppInfo, error) {
	info := &WaiterAppInfo{DownloadPath: WaiterAppDownloadPath}
	if s.apkPath == "" {
		return info, nil
	}
	fi, err := os.Stat(s.apkPath)
	if err != nil {
		if os.IsNotExist(err) {
			return info, nil
		}
		return nil, err
	}
	info.Available = true
	info.SizeBytes = fi.Size()
	if b, err := os.ReadFile(s.metaPath()); err == nil {
		var m waiterAppMeta
		if json.Unmarshal(b, &m) == nil {
			info.Version = m.Version
			info.FileName = m.FileName
			if m.SizeBytes > 0 {
				info.SizeBytes = m.SizeBytes
			}
			if !m.UploadedAt.IsZero() {
				t := m.UploadedAt
				info.UploadedAt = &t
			}
		}
	}
	if info.UploadedAt == nil {
		t := fi.ModTime()
		info.UploadedAt = &t
	}
	return info, nil
}

// Save — атомарно сохраняет новый APK + метаданные. Возвращает новое состояние.
func (s *WaiterAppService) Save(src io.Reader, version, fileName string, now time.Time) (*WaiterAppInfo, error) {
	if s.apkPath == "" {
		return nil, errWaiterAppNotConfigured
	}
	if err := os.MkdirAll(filepath.Dir(s.apkPath), 0o755); err != nil {
		return nil, err
	}
	tmp := s.apkPath + ".tmp"
	f, err := os.Create(tmp)
	if err != nil {
		return nil, err
	}
	n, copyErr := io.Copy(f, src)
	closeErr := f.Close()
	if copyErr != nil || closeErr != nil {
		_ = os.Remove(tmp)
		if copyErr != nil {
			return nil, copyErr
		}
		return nil, closeErr
	}
	if err := os.Rename(tmp, s.apkPath); err != nil {
		_ = os.Remove(tmp)
		return nil, err
	}
	meta := waiterAppMeta{Version: version, FileName: fileName, SizeBytes: n, UploadedAt: now.UTC()}
	if b, err := json.Marshal(meta); err == nil {
		_ = os.WriteFile(s.metaPath(), b, 0o644)
	}
	return s.Info()
}
