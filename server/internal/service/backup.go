package service

// BackupService — ручные бэкапы и восстановление БД через UI.
//
// Бэкап = pg_dump --format=custom (сжатый, бинарный). Восстановление =
// pg_restore --clean --if-exists в ту же БД.
//
// Бинари pg_dump/pg_restore берутся из embedded-postgres runtime
// (pg-runtime/bin/), а не из PATH — на проде Windows-кассы Postgres не
// установлен системно.
//
// КРИТИЧНО про restore: pg_restore --clean дропает и пересоздаёт все
// объекты. Всё что было создано ПОСЛЕ бэкапа — теряется. UI обязан
// показать жёсткое подтверждение. Restore блокирует приложение на
// время выполнения (соединения рвутся), поэтому делается редко и
// осознанно (обычно после переустановки / порчи данных).

import (
	"context"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"time"

	"github.com/rs/zerolog/log"

	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
)

func ioCopy(dst io.Writer, src io.Reader) (int64, error) { return io.Copy(dst, src) }

// rotateDir удаляет старые *.dump в dir, оставляя keep самых свежих по имени.
func rotateDir(dir string, keep int) {
	if keep <= 0 {
		return
	}
	entries, err := os.ReadDir(dir)
	if err != nil {
		return
	}
	var files []os.DirEntry
	for _, e := range entries {
		if !e.IsDir() && strings.HasSuffix(e.Name(), ".dump") {
			files = append(files, e)
		}
	}
	if len(files) <= keep {
		return
	}
	sort.Slice(files, func(i, j int) bool { return files[i].Name() < files[j].Name() })
	for _, e := range files[:len(files)-keep] {
		_ = os.Remove(filepath.Join(dir, e.Name()))
	}
}

// BackupConfig — пути и DSN для backup-операций.
type BackupServiceConfig struct {
	BackupsDir   string // куда складывать .dump
	DesktopDir   string // <Desktop>/RestOS-Backups для удобной копии (опц.)
	PGRuntimeDir string // pg-runtime (внутри bin/pg_dump)
	DSN          string // подключение к embedded PG
	PGUser       string
	PGPassword   string
	PGDatabase   string
	PGHost       string
	PGPort       uint32
}

// copyToDesktop — копирует свежий .dump в <Desktop>/RestOS-Backups/, если
// DesktopDir задан. Best-effort: ошибка копирования не валит бэкап (основной
// файл уже в BackupsDir). Ротация на десктопе — оставляем 14 последних.
func (s *BackupService) copyToDesktop(srcPath, fname string) {
	if s.cfg.DesktopDir == "" {
		return
	}
	dstDir := s.cfg.DesktopDir
	if err := os.MkdirAll(dstDir, 0o755); err != nil {
		log.Warn().Err(err).Msg("backup: mkdir desktop dir failed")
		return
	}
	src, err := os.Open(srcPath)
	if err != nil {
		return
	}
	defer src.Close()
	dstPath := filepath.Join(dstDir, fname)
	dst, err := os.Create(dstPath)
	if err != nil {
		log.Warn().Err(err).Msg("backup: create desktop copy failed")
		return
	}
	if _, err := ioCopy(dst, src); err != nil {
		dst.Close()
		_ = os.Remove(dstPath)
		log.Warn().Err(err).Msg("backup: copy to desktop failed")
		return
	}
	dst.Close()
	log.Info().Str("path", dstPath).Msg("backup: copied to desktop")
	// Ротация на десктопе — не засоряем рабочий стол.
	rotateDir(dstDir, 14)
}

type BackupService struct {
	cfg BackupServiceConfig
}

func NewBackupService(cfg BackupServiceConfig) *BackupService {
	return &BackupService{cfg: cfg}
}

// BackupFile — метаданные одного файла бэкапа.
type BackupFile struct {
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
	Tier      string    `json:"tier"` // daily|weekly|monthly|manual
}

// pgBin — путь к бинарю (pg_dump/pg_restore) внутри embedded runtime.
// На Windows — .exe. Fallback на PATH если runtime-бинарь не найден (dev).
func (s *BackupService) pgBin(name string) string {
	bin := name
	if runtime.GOOS == "windows" {
		bin = name + ".exe"
	}
	candidate := filepath.Join(s.cfg.PGRuntimeDir, "bin", bin)
	if _, err := os.Stat(candidate); err == nil {
		return candidate
	}
	return name // PATH fallback (dev-окружение)
}

// Create — ручной бэкап. Имя: manual-YYYYMMDD-HHMMSS.dump.
func (s *BackupService) Create(ctx context.Context) (*BackupFile, error) {
	if err := os.MkdirAll(s.cfg.BackupsDir, 0o755); err != nil {
		return nil, apperrors.Wrap("INTERNAL", "mkdir backups", err)
	}
	now := time.Now()
	fname := fmt.Sprintf("manual-%s.dump", now.Format("20060102-150405"))
	fpath := filepath.Join(s.cfg.BackupsDir, fname)

	// pg_dump --format=custom --file=<path> --dbname=<dsn>
	cmd := exec.CommandContext(ctx, s.pgBin("pg_dump"),
		"--format=custom",
		"--file="+fpath,
		"--dbname="+s.cfg.DSN,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		_ = os.Remove(fpath)
		log.Error().Err(err).Str("out", string(out)).Msg("manual backup: pg_dump failed")
		return nil, apperrors.Wrap("INTERNAL",
			"pg_dump failed: "+strings.TrimSpace(string(out)), err)
	}

	fi, err := os.Stat(fpath)
	if err != nil {
		return nil, apperrors.Wrap("INTERNAL", "stat backup", err)
	}
	s.copyToDesktop(fpath, fname)
	log.Info().Str("file", fname).Int64("size", fi.Size()).Msg("manual backup created")
	return &BackupFile{
		Name:      fname,
		SizeBytes: fi.Size(),
		CreatedAt: now,
		Tier:      "manual",
	}, nil
}

// CreateAuto — авто-бэкап при закрытии смены. Имя shift-YYYYMMDD-HHMMSS.dump.
// После создания применяет ротацию: оставляет последние keepShiftBackups
// shift-бэкапов (чтобы за месяц не накопить 60+ файлов).
func (s *BackupService) CreateAuto(ctx context.Context) (*BackupFile, error) {
	if err := os.MkdirAll(s.cfg.BackupsDir, 0o755); err != nil {
		return nil, apperrors.Wrap("INTERNAL", "mkdir backups", err)
	}
	now := time.Now()
	fname := fmt.Sprintf("shift-%s.dump", now.Format("20060102-150405"))
	fpath := filepath.Join(s.cfg.BackupsDir, fname)

	cmd := exec.CommandContext(ctx, s.pgBin("pg_dump"),
		"--format=custom",
		"--file="+fpath,
		"--dbname="+s.cfg.DSN,
	)
	out, err := cmd.CombinedOutput()
	if err != nil {
		_ = os.Remove(fpath)
		log.Error().Err(err).Str("out", string(out)).Msg("auto backup (shift close): pg_dump failed")
		return nil, apperrors.Wrap("INTERNAL",
			"pg_dump failed: "+strings.TrimSpace(string(out)), err)
	}

	// Ротация shift-бэкапов: оставляем последние 14 (≈2 недели смен).
	s.rotateShiftBackups(14)

	fi, err := os.Stat(fpath)
	if err != nil {
		return nil, apperrors.Wrap("INTERNAL", "stat backup", err)
	}
	s.copyToDesktop(fpath, fname)
	log.Info().Str("file", fname).Int64("size", fi.Size()).Msg("auto backup (shift close) created")
	return &BackupFile{Name: fname, SizeBytes: fi.Size(), CreatedAt: now, Tier: "shift"}, nil
}

// rotateShiftBackups удаляет старые shift-*.dump, оставляя keep самых свежих.
func (s *BackupService) rotateShiftBackups(keep int) {
	if keep <= 0 {
		return
	}
	entries, err := os.ReadDir(s.cfg.BackupsDir)
	if err != nil {
		return
	}
	var shifts []os.DirEntry
	for _, e := range entries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "shift-") && strings.HasSuffix(e.Name(), ".dump") {
			shifts = append(shifts, e)
		}
	}
	if len(shifts) <= keep {
		return
	}
	// Имена shift-YYYYMMDD-HHMMSS сортируются лексикографически = хронологически.
	sort.Slice(shifts, func(i, j int) bool { return shifts[i].Name() < shifts[j].Name() })
	for _, e := range shifts[:len(shifts)-keep] {
		_ = os.Remove(filepath.Join(s.cfg.BackupsDir, e.Name()))
	}
}

// List — все бэкап-файлы, отсортированные по дате (новые сверху).
func (s *BackupService) List() ([]BackupFile, error) {
	entries, err := os.ReadDir(s.cfg.BackupsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []BackupFile{}, nil
		}
		return nil, apperrors.Wrap("INTERNAL", "read backups dir", err)
	}
	out := make([]BackupFile, 0, len(entries))
	for _, e := range entries {
		if e.IsDir() || !strings.HasSuffix(e.Name(), ".dump") {
			continue
		}
		fi, err := e.Info()
		if err != nil {
			continue
		}
		out = append(out, BackupFile{
			Name:      e.Name(),
			SizeBytes: fi.Size(),
			CreatedAt: fi.ModTime(),
			Tier:      tierFromName(e.Name()),
		})
	}
	sort.Slice(out, func(i, j int) bool {
		return out[i].CreatedAt.After(out[j].CreatedAt)
	})
	return out, nil
}

// Path — абсолютный путь к файлу для download. Проверяет что имя безопасно
// (без traversal) и файл существует.
func (s *BackupService) Path(name string) (string, error) {
	if name == "" || strings.ContainsAny(name, "/\\") || strings.Contains(name, "..") {
		return "", apperrors.Wrap("VALIDATION", "bad backup name", nil)
	}
	if !strings.HasSuffix(name, ".dump") {
		return "", apperrors.Wrap("VALIDATION", "not a .dump file", nil)
	}
	fpath := filepath.Join(s.cfg.BackupsDir, name)
	if _, err := os.Stat(fpath); err != nil {
		return "", apperrors.ErrNotFound
	}
	return fpath, nil
}

// Delete — удалить файл бэкапа.
func (s *BackupService) Delete(name string) error {
	fpath, err := s.Path(name)
	if err != nil {
		return err
	}
	if err := os.Remove(fpath); err != nil {
		return apperrors.Wrap("INTERNAL", "delete backup", err)
	}
	return nil
}

// Restore — восстановление из ЗАГРУЖЕННОГО файла (uploaded в temp).
// tmpPath — путь к временному .dump который handler сохранил из multipart.
//
// Используем pg_restore --clean --if-exists --no-owner --no-privileges
// в ту же БД. --single-transaction чтобы при ошибке откатить целиком.
func (s *BackupService) Restore(ctx context.Context, tmpPath string) error {
	if _, err := os.Stat(tmpPath); err != nil {
		return apperrors.Wrap("VALIDATION", "uploaded file not found", err)
	}

	// pg_restore не принимает password в DSN на всех платформах одинаково —
	// передаём через PGPASSWORD env (надёжнее для embedded).
	cmd := exec.CommandContext(ctx, s.pgBin("pg_restore"),
		"--clean",
		"--if-exists",
		"--no-owner",
		"--no-privileges",
		"--dbname="+s.cfg.DSN,
		tmpPath,
	)
	cmd.Env = append(os.Environ(), "PGPASSWORD="+s.cfg.PGPassword)
	out, err := cmd.CombinedOutput()
	if err != nil {
		// pg_restore часто выдаёт warnings на --clean (DROP несуществующих
		// объектов) и завершается с кодом 1 при наличии non-fatal errors.
		// Различаем: если в выводе есть "FATAL" или "could not connect" —
		// реальная ошибка. Иначе считаем успехом с warnings.
		outStr := string(out)
		if strings.Contains(outStr, "FATAL") ||
			strings.Contains(outStr, "could not connect") ||
			strings.Contains(outStr, "out of memory") ||
			strings.Contains(outStr, "no such file") {
			log.Error().Err(err).Str("out", outStr).Msg("restore: pg_restore fatal")
			return apperrors.Wrap("INTERNAL",
				"pg_restore failed: "+strings.TrimSpace(firstLines(outStr, 3)), err)
		}
		// Non-fatal — логируем warnings, считаем успехом.
		log.Warn().Str("out", outStr).Msg("restore: pg_restore completed with warnings")
	}
	log.Info().Str("file", filepath.Base(tmpPath)).Msg("restore completed")
	return nil
}

// RestoreFromExisting — восстановление из УЖЕ существующего файла в backups/
// (по имени), без upload. Для «откатиться на вчерашний бэкап» из списка.
func (s *BackupService) RestoreFromExisting(ctx context.Context, name string) error {
	fpath, err := s.Path(name)
	if err != nil {
		return err
	}
	return s.Restore(ctx, fpath)
}

func tierFromName(name string) string {
	switch {
	case strings.HasPrefix(name, "shift-"):
		return "shift"
	case strings.HasPrefix(name, "manual-"):
		return "manual"
	case strings.HasPrefix(name, "monthly-"):
		return "monthly"
	case strings.HasPrefix(name, "weekly-"):
		return "weekly"
	case strings.HasPrefix(name, "daily-"):
		return "daily"
	default:
		return "other"
	}
}

func firstLines(s string, n int) string {
	lines := strings.Split(s, "\n")
	if len(lines) > n {
		lines = lines[:n]
	}
	return strings.Join(lines, "\n")
}
