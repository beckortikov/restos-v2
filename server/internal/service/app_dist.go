package service

// AppDistService — раздача APK-приложений, которые касса хранит у себя и отдаёт
// по LAN/QR (официант, закупщик). Обобщение бывшего WaiterAppService: теперь
// вариантов несколько, каждый со своим файлом в userData и своим публичным
// путём скачивания.
//
// Вариант C: APK загружается менеджером через настройки кассы и хранится в
// userData (DataDir). Сервер отдаёт файл публично по <downloadPath>, телефон
// качает его по QR. Обновление APK = новая загрузка, без пересборки кассы.

import (
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/apkmeta"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
)

var errAppDistNotConfigured = apperrors.Wrap("VALIDATION", "хранилище APK не сконфигурировано", nil)

// Публичные пути скачивания (вне /api/v1, без авторизации).
const (
	WaiterAppDownloadPath = "/download/waiter.apk"
	ZakupAppDownloadPath  = "/download/zakup.apk"
)

// AppDistService раздаёт один вариант APK.
type AppDistService struct {
	apkPath        string // "" → не сконфигурировано (dev/тест без DataDir)
	downloadPath   string // публичный маршрут скачивания
	attachmentName string // имя файла в Content-Disposition + для ServeContent
}

// NewAppDistService — общий конструктор варианта раздачи.
func NewAppDistService(apkPath, downloadPath, attachmentName string) *AppDistService {
	return &AppDistService{apkPath: apkPath, downloadPath: downloadPath, attachmentName: attachmentName}
}

// NewWaiterAppService — вариант «приложение официанта».
func NewWaiterAppService(apkPath string) *AppDistService {
	return NewAppDistService(apkPath, WaiterAppDownloadPath, "restos-waiter.apk")
}

// NewZakupAppService — вариант «приложение закупщика».
func NewZakupAppService(apkPath string) *AppDistService {
	return NewAppDistService(apkPath, ZakupAppDownloadPath, "restos-zakup.apk")
}

// Path — абсолютный путь к файлу APK ("" если не сконфигурировано).
func (s *AppDistService) Path() string { return s.apkPath }

// DownloadPath — публичный маршрут скачивания этого варианта.
func (s *AppDistService) DownloadPath() string { return s.downloadPath }

// AttachmentName — имя файла для скачивания.
func (s *AppDistService) AttachmentName() string { return s.attachmentName }

func (s *AppDistService) metaPath() string {
	if s.apkPath == "" {
		return ""
	}
	return s.apkPath + ".json"
}

// appDistMeta — метаданные загрузки (рядом с APK).
type appDistMeta struct {
	Version     string    `json:"version"`      // versionName из APK
	VersionCode int       `json:"version_code"` // versionCode из APK (для сравнения)
	FileName    string    `json:"file_name"`
	SizeBytes   int64     `json:"size_bytes"`
	UploadedAt  time.Time `json:"uploaded_at"`
}

// AppDistInfo — состояние APK для UI кассы и автообновления приложения.
type AppDistInfo struct {
	Available    bool       `json:"available"`
	Version      string     `json:"version"`      // versionName, напр. "0.2.16"
	VersionCode  int        `json:"version_code"` // versionCode, напр. 18
	FileName     string     `json:"file_name"`
	SizeBytes    int64      `json:"size_bytes"`
	UploadedAt   *time.Time `json:"uploaded_at"`
	DownloadPath string     `json:"download_path"`
}

// Info — текущее состояние APK (есть ли, версия, размер, дата).
func (s *AppDistService) Info() (*AppDistInfo, error) {
	info := &AppDistInfo{DownloadPath: s.downloadPath}
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
		var m appDistMeta
		if json.Unmarshal(b, &m) == nil {
			info.Version = m.Version
			info.VersionCode = m.VersionCode
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
	// APK загружен до этой доработки (нет version_code в meta) — парсим на лету,
	// чтобы автообновление корректно сравнивало версии.
	if info.VersionCode == 0 {
		if pm, perr := apkmeta.Read(s.apkPath); perr == nil {
			info.VersionCode = pm.VersionCode
			if info.Version == "" {
				info.Version = pm.VersionName
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
func (s *AppDistService) Save(src io.Reader, version, fileName string, now time.Time) (*AppDistInfo, error) {
	if s.apkPath == "" {
		return nil, errAppDistNotConfigured
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
	// Версию берём из самого APK (AndroidManifest.xml) — форма загрузки её не
	// передаёт. Если распарсить не удалось, оставляем то, что пришло в запросе.
	versionCode := 0
	if pm, perr := apkmeta.Read(s.apkPath); perr == nil {
		versionCode = pm.VersionCode
		if pm.VersionName != "" {
			version = pm.VersionName
		}
	}
	meta := appDistMeta{Version: version, VersionCode: versionCode, FileName: fileName, SizeBytes: n, UploadedAt: now.UTC()}
	if b, err := json.Marshal(meta); err == nil {
		_ = os.WriteFile(s.metaPath(), b, 0o644)
	}
	return s.Info()
}
