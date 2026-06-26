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
	"gorm.io/gorm"

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
	// db — пул приложения. Нужен restore'у: чтобы оборвать остальные сессии
	// (иначе DROP в --clean не получит эксклюзивную блокировку) и сбросить пул
	// после восстановления (иначе pgx держит prepared statements со старыми
	// OID'ами таблиц → «cached plan must not change result type»). Может быть
	// nil в тестах/dev без БД — тогда шаги с пулом пропускаются.
	db *gorm.DB
}

func NewBackupService(cfg BackupServiceConfig) *BackupService {
	return &BackupService{cfg: cfg}
}

// WithDB привязывает пул приложения к сервису (для restore). Возвращает s для
// чейнинга: service.NewBackupService(cfg).WithDB(gdb).
func (s *BackupService) WithDB(db *gorm.DB) *BackupService {
	s.db = db
	return s
}

// BackupFile — метаданные одного файла бэкапа.
type BackupFile struct {
	Name      string    `json:"name"`
	SizeBytes int64     `json:"size_bytes"`
	CreatedAt time.Time `json:"created_at"`
	Tier      string    `json:"tier"` // daily|weekly|monthly|manual
}

// pgBin ищет бинарь (pg_dump/pg_restore) в нескольких местах по порядку:
//  1. embedded runtime (pg-runtime/bin) — если используется embedded-postgres
//  2. PATH — если PostgreSQL установлен системно и в PATH
//  3. типовые системные пути установки PostgreSQL (Windows/macOS/Linux)
//
// v3.9.5: раньше при external/system PostgreSQL (pg-runtime пустой) падали
// на «pg_dump» из PATH, которого на Windows-кассе нет → exec-ошибка с пустым
// выводом. Теперь сканируем реальные пути установки. Возвращает ("", false)
// если бинарь нигде не найден — вызывающий выдаёт понятную ошибку.
func (s *BackupService) pgBin(name string) (string, bool) {
	bin := name
	if runtime.GOOS == "windows" {
		bin = name + ".exe"
	}

	// 0. Environment variable override (e.g., passed from Electron)
	envKey := "RESTOS_PG_DUMP_PATH"
	if name == "pg_restore" {
		envKey = "RESTOS_PG_RESTORE_PATH"
	}
	if envVal := os.Getenv(envKey); envVal != "" {
		if _, err := os.Stat(envVal); err == nil {
			return envVal, true
		}
	}

	// 0.1. Relative to the running server executable
	if execPath, err := os.Executable(); err == nil {
		execDir := filepath.Dir(execPath)
		// Option A: next to the executable
		c := filepath.Join(execDir, bin)
		if _, err := os.Stat(c); err == nil {
			return c, true
		}
		// Option B: inside a bin/ subdirectory next to the executable
		cSub := filepath.Join(execDir, "bin", bin)
		if _, err := os.Stat(cSub); err == nil {
			return cSub, true
		}
	}

	// 1. Embedded runtime.
	if s.cfg.PGRuntimeDir != "" {
		c := filepath.Join(s.cfg.PGRuntimeDir, "bin", bin)
		if _, err := os.Stat(c); err == nil {
			return c, true
		}
	}

	// 2. PATH.
	if p, err := exec.LookPath(bin); err == nil {
		return p, true
	}

	// 3. Типовые системные пути. Берём САМУЮ НОВУЮ версию (pg_dump новее
	// сервера всегда совместим; старее — нет). Сортируем glob по убыванию.
	var globs []string
	switch runtime.GOOS {
	case "windows":
		globs = []string{
			`C:\Program Files\PostgreSQL\*\bin\` + bin,
			`C:\Program Files (x86)\PostgreSQL\*\bin\` + bin,
		}
	case "darwin":
		globs = []string{
			"/Library/PostgreSQL/*/bin/" + bin,
			"/opt/homebrew/opt/postgresql@*/bin/" + bin,
			"/usr/local/opt/postgresql@*/bin/" + bin,
			"/opt/homebrew/bin/" + bin,
			"/usr/local/bin/" + bin,
		}
	default: // linux
		globs = []string{
			"/usr/lib/postgresql/*/bin/" + bin,
			"/usr/pgsql-*/bin/" + bin,
			"/usr/bin/" + bin,
		}
	}
	var best string
	for _, g := range globs {
		matches, _ := filepath.Glob(g)
		sort.Sort(sort.Reverse(sort.StringSlice(matches)))
		for _, m := range matches {
			if _, err := os.Stat(m); err == nil {
				best = m
				break
			}
		}
		if best != "" {
			break
		}
	}
	if best != "" {
		return best, true
	}
	return "", false
}

// prepareCmdEnv готовит окружение для выполнения команд pg_dump/pg_restore.
// На Windows утилитам нужны DLL (например, libpq.dll), которые лежат в pg-runtime/bin
// или в папке самого бинаря. Добавляем эти пути в PATH.
func (s *BackupService) prepareCmdEnv(binPath string) []string {
	env := os.Environ()
	env = append(env, "PGPASSWORD="+s.cfg.PGPassword)

	// Собираем пути для добавления в PATH
	var extraPaths []string
	if s.cfg.PGRuntimeDir != "" {
		extraPaths = append(extraPaths, filepath.Join(s.cfg.PGRuntimeDir, "bin"))
	}
	if binPath != "" {
		extraPaths = append(extraPaths, filepath.Dir(binPath))
	}

	if len(extraPaths) == 0 {
		return env
	}

	pathKey := "PATH"
	found := false
	for i, kv := range env {
		parts := strings.SplitN(kv, "=", 2)
		if len(parts) == 2 && strings.ToUpper(parts[0]) == "PATH" {
			pathKey = parts[0]
			oldVal := parts[1]

			// Объединяем новые пути и старый PATH
			newVal := strings.Join(extraPaths, string(os.PathListSeparator))
			if oldVal != "" {
				newVal += string(os.PathListSeparator) + oldVal
			}
			env[i] = pathKey + "=" + newVal
			found = true
			break
		}
	}
	if !found {
		env = append(env, "PATH="+strings.Join(extraPaths, string(os.PathListSeparator)))
	}

	return env
}

// Create — ручной бэкап. Имя: manual-YYYYMMDD-HHMMSS.dump.
func (s *BackupService) Create(ctx context.Context) (*BackupFile, error) {
	if err := os.MkdirAll(s.cfg.BackupsDir, 0o755); err != nil {
		return nil, apperrors.Wrap("INTERNAL", "mkdir backups", err)
	}
	now := time.Now()
	fname := fmt.Sprintf("manual-%s.dump", now.Format("20060102-150405"))
	fpath := filepath.Join(s.cfg.BackupsDir, fname)

	dumpBin, ok := s.pgBin("pg_dump")
	if !ok {
		return nil, apperrors.Wrap("INTERNAL", pgToolNotFoundMsg("pg_dump"), nil)
	}
	// pg_dump --format=custom --file=<path> --dbname=<dsn>
	cmd := exec.CommandContext(ctx, dumpBin,
		"--format=custom",
		"--file="+fpath,
		"--dbname="+s.cfg.DSN,
	)
	cmd.Env = s.prepareCmdEnv(dumpBin)
	out, err := cmd.CombinedOutput()
	if err != nil {
		_ = os.Remove(fpath)
		log.Error().Err(err).Str("bin", dumpBin).Str("out", string(out)).Msg("manual backup: pg_dump failed")
		return nil, apperrors.Wrap("INTERNAL", pgDumpErrMsg(out, err), err)
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

// pgToolNotFoundMsg — понятная ошибка когда бинарь pg_dump/pg_restore нигде
// не найден (ни embedded runtime, ни PATH, ни системные пути).
func pgToolNotFoundMsg(tool string) string {
	return tool + " не найден: PostgreSQL client tools не установлены или " +
		"embedded-runtime повреждён. Переустановите кассу или установите PostgreSQL."
}

// pgDumpErrMsg строит сообщение из stderr pg_dump'а ИЛИ самой exec-ошибки
// (когда stderr пустой — например, версионный mismatch или сетевой сбой).
func pgDumpErrMsg(out []byte, err error) string {
	s := strings.TrimSpace(string(out))
	if s == "" && err != nil {
		s = err.Error()
	}
	return "pg_dump failed: " + s
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

	dumpBin, ok := s.pgBin("pg_dump")
	if !ok {
		return nil, apperrors.Wrap("INTERNAL", pgToolNotFoundMsg("pg_dump"), nil)
	}
	cmd := exec.CommandContext(ctx, dumpBin,
		"--format=custom",
		"--file="+fpath,
		"--dbname="+s.cfg.DSN,
	)
	cmd.Env = s.prepareCmdEnv(dumpBin)
	out, err := cmd.CombinedOutput()
	if err != nil {
		_ = os.Remove(fpath)
		log.Error().Err(err).Str("bin", dumpBin).Str("out", string(out)).Msg("auto backup (shift close): pg_dump failed")
		return nil, apperrors.Wrap("INTERNAL", pgDumpErrMsg(out, err), err)
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
// --single-transaction --exit-on-error в ту же БД:
//   - --single-transaction + --exit-on-error → восстановление АТОМАРНО.
//     Любая ошибка обрывает процесс с ненулевым кодом и откатывает всё.
//     Поэтому ненулевой exit = реальный провал (раньше код «глотал» ошибки
//     pg_restore как warnings и врал об успехе — данные не менялись, а UI
//     писал «восстановление завершено»).
//   - перед запуском обрываем остальные сессии к БД и сбрасываем пул, иначе
//     DROP в --clean не получит эксклюзивную блокировку и зависнет.
//   - после успеха пересоздаём соединения пула: pgx кэширует prepared
//     statements со старыми OID'ами дропнутых таблиц → без сброса первые же
//     запросы упадут «cached plan must not change result type».
func (s *BackupService) Restore(ctx context.Context, tmpPath string) error {
	if _, err := os.Stat(tmpPath); err != nil {
		return apperrors.Wrap("VALIDATION", "uploaded file not found", err)
	}

	// pg_restore не принимает password в DSN на всех платформах одинаково —
	// передаём через PGPASSWORD env (надёжнее для embedded).
	restoreBin, ok := s.pgBin("pg_restore")
	if !ok {
		return apperrors.Wrap("INTERNAL", pgToolNotFoundMsg("pg_restore"), nil)
	}

	// Обрываем остальные сессии приложения к БД и закрываем idle-соединения
	// пула, чтобы DROP TABLE в --clean смог взять ACCESS EXCLUSIVE lock.
	s.terminateOtherSessions(ctx)

	cmd := exec.CommandContext(ctx, restoreBin,
		"--clean",
		"--if-exists",
		"--no-owner",
		"--no-privileges",
		"--single-transaction",
		"--exit-on-error",
		"--dbname="+s.cfg.DSN,
		tmpPath,
	)
	// lock_timeout: если живое соединение всё-таки держит таблицу — не виснем
	// бесконечно, а падаем с понятной ошибкой. statement_timeout=0: сам restore
	// большой БД может идти долго, его не ограничиваем.
	cmd.Env = append(s.prepareCmdEnv(restoreBin),
		"PGOPTIONS=-c lock_timeout=15000 -c statement_timeout=0")
	out, err := cmd.CombinedOutput()
	if err != nil {
		// --single-transaction + --exit-on-error: любой ненулевой код = провал,
		// БД откачена к состоянию до restore. Никаких «успехов с warnings».
		outStr := strings.TrimSpace(string(out))
		log.Error().Err(err).Str("out", outStr).Msg("restore: pg_restore failed")
		msg := firstLines(outStr, 5)
		if msg == "" {
			msg = err.Error()
		}
		// Соединения мы уже оборвали — восстанавливаем пул, чтобы приложение
		// продолжило работать на старых (нетронутых) данных.
		s.recyclePool()
		return apperrors.Wrap("INTERNAL", "pg_restore failed: "+msg, err)
	}

	// Успех: данные заменены. Пересоздаём соединения пула, иначе кэш prepared
	// statements pgx ссылается на дропнутые таблицы.
	s.recyclePool()
	log.Info().Str("file", filepath.Base(tmpPath)).Msg("restore completed")
	return nil
}

// terminateOtherSessions обрывает все прочие подключения к целевой БД (кроме
// текущего) и закрывает idle-соединения пула приложения. Нужно, чтобы DROP в
// pg_restore --clean получил эксклюзивную блокировку. Best-effort: если db не
// привязан (тесты/dev) или запрос не прошёл — просто логируем.
func (s *BackupService) terminateOtherSessions(ctx context.Context) {
	if s.db == nil {
		return
	}
	// Закрываем idle-пул приложения, чтобы он сам не держал блокировки.
	if sqlDB, err := s.db.DB(); err == nil {
		sqlDB.SetMaxIdleConns(0)
		sqlDB.SetMaxIdleConns(10)
	}
	// Обрываем все остальные backend'ы на этой БД.
	err := s.db.WithContext(ctx).Exec(`
		SELECT pg_terminate_backend(pid)
		FROM pg_stat_activity
		WHERE datname = current_database()
		  AND pid <> pg_backend_pid()
	`).Error
	if err != nil {
		log.Warn().Err(err).Msg("restore: terminate other sessions failed (continuing)")
	}
}

// recyclePool закрывает все текущие соединения пула приложения, чтобы после
// restore не остался кэш prepared statements/схемы со старыми OID'ами.
// Set(0) закрывает idle-соединения немедленно; занятые закроются при возврате.
func (s *BackupService) recyclePool() {
	if s.db == nil {
		return
	}
	sqlDB, err := s.db.DB()
	if err != nil {
		return
	}
	sqlDB.SetMaxIdleConns(0)
	sqlDB.SetMaxIdleConns(10)
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
