package service

// Селфи при отметке (103) — приём, хранение и отдача.
//
// PIN доказывает только знание четырёх цифр, а их передают друг другу. Фото не
// мешает передать PIN, но делает подмену видимой: владелец листает ленту и
// сразу видит, кто на самом деле отметился. Это доказательство постфактум, а
// не биометрия, и распознаванием лиц мы не занимаемся.

import (
	"bytes"
	"context"
	"encoding/base64"
	"errors"
	"fmt"
	"image"
	"image/jpeg"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"golang.org/x/image/draw"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

const (
	// maxPhotoBytes — предохранитель на входящий снимок. Терминал шлёт ~640px
	// JPEG (30–50 КБ); полмегабайта — это уже «клиент не сжал», и принимать
	// такое молча нельзя: снимков накапливается по два на человека в день.
	maxPhotoBytes = 512 * 1024

	// thumbMaxSide — сторона превью, которое уезжает в центр. 160px хватает,
	// чтобы узнать человека в списке, и даёт ~8 КБ вместо ~40.
	thumbMaxSide = 160

	// photoRetentionDays — сколько хранить оригиналы. Спор «это не я
	// отмечался» живёт максимум до расчёта зарплаты за период; держать
	// снимки людей дольше — без нужды копить персональные данные.
	photoRetentionDays = 90
)

// AttendancePhotoStore — файловое хранилище оригиналов + запись в БД.
type AttendancePhotoStore struct {
	r   *repo.Repo
	dir string // "" → фото отключены (dev/тесты без data-dir)
}

func NewAttendancePhotoStore(r *repo.Repo, dir string) *AttendancePhotoStore {
	return &AttendancePhotoStore{r: r, dir: dir}
}

// Enabled — сконфигурировано ли хранилище. Без data-dir терминал продолжает
// отмечать людей, просто без снимков: отсутствие фото не повод не пустить
// человека на смену.
func (s *AttendancePhotoStore) Enabled() bool { return s != nil && s.dir != "" }

// Save — принять снимок отметки. Ошибки НЕ фатальны для самой отметки: она уже
// записана в табель, и терять её из-за проблем с диском нельзя.
func (s *AttendancePhotoStore) Save(ctx context.Context, entryID, userID, kind string, rawB64 string) error {
	if !s.Enabled() || strings.TrimSpace(rawB64) == "" {
		return nil
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	data, err := decodePhoto(rawB64)
	if err != nil {
		return err
	}
	img, err := jpeg.Decode(bytes.NewReader(data))
	if err != nil {
		return apperrors.Wrap("VALIDATION", "снимок должен быть JPEG", err)
	}
	thumb, err := makeThumb(img)
	if err != nil {
		return err
	}

	// Каталог по месяцам: чистка ретенцией и ручной разбор идут помесячно, и
	// один плоский каталог на десятки тысяч файлов этому мешает.
	month := time.Now().Format("2006-01")
	id := uuid.NewString()
	rel := filepath.Join(month, id+".jpg")
	abs := filepath.Join(s.dir, rel)
	if err := os.MkdirAll(filepath.Dir(abs), 0o755); err != nil {
		return fmt.Errorf("attendance photo dir: %w", err)
	}
	if err := os.WriteFile(abs, data, 0o644); err != nil {
		return fmt.Errorf("attendance photo write: %w", err)
	}

	row := models.AttendancePhoto{
		ID: id, RestaurantID: &rid, EntryID: entryID, Kind: kind,
		TakenAt: time.Now().UTC(), Path: &rel, Thumb: thumb, CreatedAt: time.Now().UTC(),
	}
	if userID != "" {
		row.UserID = &userID
	}
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Create(&row).Error; err != nil {
			return err
		}
		return recordAttendancePhotoSync(tx, row.ID)
	})
	if err != nil {
		// Файл уже лёг на диск — убираем, чтобы не копить сирот, на которые
		// никто никогда не сошлётся.
		_ = os.Remove(abs)
		return err
	}
	return nil
}

// ForEntries — превью по списку отметок (для переклички и табеля).
func (s *AttendancePhotoStore) ForEntries(ctx context.Context, entryIDs []string) (map[string]models.AttendancePhoto, error) {
	out := map[string]models.AttendancePhoto{}
	if len(entryIDs) == 0 {
		return out, nil
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.AttendancePhoto
	if err := scoped.Where("entry_id IN ?", entryIDs).Find(&rows).Error; err != nil {
		return nil, err
	}
	for _, row := range rows {
		out[row.EntryID+"|"+row.Kind] = row
	}
	return out, nil
}

// Original — оригинал снимка с диска. NOT_FOUND, если записи нет или файл уже
// вычищен ретенцией (превью при этом могло остаться — оно в БД).
func (s *AttendancePhotoStore) Original(ctx context.Context, entryID, kind string) ([]byte, error) {
	if !s.Enabled() {
		return nil, apperrors.ErrNotFound
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var row models.AttendancePhoto
	if err := scoped.Where("entry_id = ? AND kind = ?", entryID, kind).First(&row).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if row.Path == nil || *row.Path == "" {
		return nil, apperrors.ErrNotFound
	}
	// Путь из БД мог приехать с ЧУЖОГО узла синком — склеиваем его со своим
	// каталогом и проверяем, что не выбрались наружу: '../' в реплицированной
	// строке иначе читал бы произвольный файл кассы.
	clean := filepath.Clean(filepath.Join(s.dir, *row.Path))
	if !strings.HasPrefix(clean, filepath.Clean(s.dir)+string(os.PathSeparator)) {
		return nil, apperrors.ErrNotFound
	}
	data, err := os.ReadFile(clean)
	if err != nil {
		return nil, apperrors.ErrNotFound
	}
	return data, nil
}

// Purge — удалить оригиналы старше retention. Строки в БД остаются: превью
// весит копейки, а без строки в перекличке за прошлый месяц пропала бы сама
// отметка о том, что снимок был.
func (s *AttendancePhotoStore) Purge(ctx context.Context, retention time.Duration) (int, error) {
	if !s.Enabled() {
		return 0, nil
	}
	cutoff := time.Now().Add(-retention)
	var rows []models.AttendancePhoto
	if err := s.r.Raw().WithContext(ctx).
		Where("path IS NOT NULL AND taken_at < ?", cutoff).Find(&rows).Error; err != nil {
		return 0, err
	}
	removed := 0
	for _, row := range rows {
		if row.Path == nil {
			continue
		}
		abs := filepath.Clean(filepath.Join(s.dir, *row.Path))
		if !strings.HasPrefix(abs, filepath.Clean(s.dir)+string(os.PathSeparator)) {
			continue
		}
		if err := os.Remove(abs); err != nil && !os.IsNotExist(err) {
			log.Warn().Err(err).Str("path", abs).Msg("attendance photo purge: не удалось удалить файл")
			continue
		}
		if err := s.r.Raw().WithContext(ctx).Model(&models.AttendancePhoto{}).
			Where("id = ?", row.ID).Update("path", nil).Error; err != nil {
			return removed, err
		}
		removed++
	}
	return removed, nil
}

// ─── Вспомогательное ───────────────────────────────────────────────────────

// decodePhoto — base64 (с data-URL префиксом или без) → байты JPEG.
func decodePhoto(raw string) ([]byte, error) {
	v := strings.TrimSpace(raw)
	if i := strings.Index(v, ","); strings.HasPrefix(v, "data:") && i > 0 {
		v = v[i+1:]
	}
	data, err := base64.StdEncoding.DecodeString(v)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "снимок должен быть base64", err)
	}
	if len(data) > maxPhotoBytes {
		return nil, apperrors.Wrap("VALIDATION",
			fmt.Sprintf("снимок больше %d КБ — сожмите на устройстве", maxPhotoBytes/1024), nil)
	}
	return data, nil
}

// makeThumb — превью с сохранением пропорций. CatmullRom, а не NearestNeighbor:
// на 160px разница между «узнаваемое лицо» и «мозаика» решает, зачем вообще
// нужен снимок.
func makeThumb(src image.Image) ([]byte, error) {
	b := src.Bounds()
	w, h := b.Dx(), b.Dy()
	if w <= 0 || h <= 0 {
		return nil, apperrors.Wrap("VALIDATION", "пустой снимок", nil)
	}
	scale := float64(thumbMaxSide) / float64(max(w, h))
	if scale > 1 {
		scale = 1
	}
	tw, th := int(float64(w)*scale), int(float64(h)*scale)
	if tw < 1 {
		tw = 1
	}
	if th < 1 {
		th = 1
	}
	dst := image.NewRGBA(image.Rect(0, 0, tw, th))
	draw.CatmullRom.Scale(dst, dst.Bounds(), src, b, draw.Over, nil)
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, dst, &jpeg.Options{Quality: 70}); err != nil {
		return nil, fmt.Errorf("thumb encode: %w", err)
	}
	return buf.Bytes(), nil
}

func max(a, b int) int {
	if a > b {
		return a
	}
	return b
}
