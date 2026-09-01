//go:build integration

package http_test

import (
	"bytes"
	"encoding/base64"
	"encoding/json"
	"image"
	"image/color"
	"image/jpeg"
	"net/http"
	"os"
	"path/filepath"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// jpegB64 — валидный JPEG заданного размера в base64. Настоящая картинка, а не
// случайные байты: сервер декодирует её и строит превью, и на мусоре тест
// проверял бы только отказ.
func jpegB64(t *testing.T, w, h int) string {
	t.Helper()
	img := image.NewRGBA(image.Rect(0, 0, w, h))
	for y := 0; y < h; y++ {
		for x := 0; x < w; x++ {
			img.Set(x, y, color.RGBA{R: uint8(x % 255), G: uint8(y % 255), B: 120, A: 255})
		}
	}
	var buf bytes.Buffer
	if err := jpeg.Encode(&buf, img, &jpeg.Options{Quality: 70}); err != nil {
		t.Fatal(err)
	}
	return base64.StdEncoding.EncodeToString(buf.Bytes())
}

// Селфи при отметке: оригинал ложится файлом на диск, превью — в БД (оно
// уезжает в центр), перекличка отдаёт превью, оригинал доступен по entry_id.
func TestAttendancePhoto_SavedAndServed(t *testing.T) {
	f := setupE2E(t)
	gdb := openTestDB(t)
	tok := seedTerminal(t, f, gdb, "1111")

	waiter, name, pin := "waiter", "Фотогеничный", "5566"
	userID := uuid.NewString()
	gdb.Create(&models.User{ID: userID, Name: &name, Role: &waiter, PIN: &pin, RestaurantID: &f.rid})

	r, b := f.post(t, "/api/v1/attendance/punch", tok, uuid.NewString(), map[string]any{
		"pin": pin, "action": "in", "photo": jpegB64(t, 640, 480),
	})
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("punch: %d %v", r.StatusCode, out)
	}
	if out["photo_saved"] != true {
		t.Fatalf("снимок не прикрепился: %v", out)
	}
	entryID, _ := out["entry_id"].(string)

	var photo models.AttendancePhoto
	if err := gdb.Where("entry_id = ? AND kind = ?", entryID, "in").First(&photo).Error; err != nil {
		t.Fatalf("нет записи снимка: %v", err)
	}
	// Превью обязано быть в БД: именно оно уезжает в центр.
	if len(photo.Thumb) == 0 {
		t.Fatalf("превью пустое")
	}
	// И оно должно быть заметно меньше оригинала, иначе смысл разделения
	// теряется и синк потащит мегабайты.
	if len(photo.Thumb) > 30*1024 {
		t.Fatalf("превью %d байт — слишком тяжёлое для синка", len(photo.Thumb))
	}
	thumbImg, err := jpeg.Decode(bytes.NewReader(photo.Thumb))
	if err != nil {
		t.Fatalf("превью не декодируется: %v", err)
	}
	if thumbImg.Bounds().Dx() > 160 || thumbImg.Bounds().Dy() > 160 {
		t.Fatalf("превью больше 160px: %v", thumbImg.Bounds())
	}

	// Оригинал — файлом на диске, не в БД: pg_dump не должен его таскать.
	if photo.Path == nil || *photo.Path == "" {
		t.Fatalf("путь к оригиналу пуст")
	}
	if filepath.IsAbs(*photo.Path) {
		t.Fatalf("путь должен быть относительным (реплика приезжает на другой узел): %s", *photo.Path)
	}

	// Отдача оригинала.
	r, body := f.get(t, "/api/v1/attendance/photo/"+entryID+"?kind=in", tok)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("photo: %d", r.StatusCode)
	}
	if ct := r.Header.Get("Content-Type"); ct != "image/jpeg" {
		t.Fatalf("Content-Type: %s", ct)
	}
	if _, err := jpeg.Decode(bytes.NewReader(body)); err != nil {
		t.Fatalf("отданный оригинал не JPEG: %v", err)
	}

	// Перекличка отдаёт превью, а не оригинал: 20 строк по 40 КБ никому не нужны.
	gdb.Model(&models.User{}).Where("restaurant_id = ? AND role = ?", f.rid, "cashier").
		Update("permissions", datatypes.JSON([]byte(`{"actions":{"payroll.manage":true}}`)))
	date := photo.TakenAt.Local().Format("2006-01-02")
	r, b = f.get(t, "/api/v1/schedule/roll-call?date="+date, f.login(t))
	if r.StatusCode != http.StatusOK {
		t.Fatalf("roll-call: %d %s", r.StatusCode, b)
	}
	var rep struct {
		Rows []struct {
			UserID     string `json:"user_id"`
			EntryID    string `json:"entry_id"`
			PhotoThumb string `json:"photo_thumb"`
		} `json:"rows"`
	}
	_ = json.Unmarshal(b, &rep)
	found := false
	for _, row := range rep.Rows {
		if row.UserID == userID {
			found = true
			if row.EntryID != entryID || row.PhotoThumb == "" {
				t.Fatalf("в перекличке нет превью: %+v", row)
			}
		}
	}
	if !found {
		t.Fatalf("сотрудник не попал в перекличку: %+v", rep.Rows)
	}
}

// Отметка не должна срываться из-за снимка: битый файл отклоняется, но приход
// засчитывается — не пускать человека на смену из-за фото хуже, чем принять
// отметку без доказательства.
func TestAttendancePhoto_BadPhotoStillPunches(t *testing.T) {
	f := setupE2E(t)
	gdb := openTestDB(t)
	tok := seedTerminal(t, f, gdb, "1111")

	cook, name, pin := "cook", "Без камеры", "7799"
	userID := uuid.NewString()
	gdb.Create(&models.User{ID: userID, Name: &name, Role: &cook, PIN: &pin, RestaurantID: &f.rid})

	r, b := f.post(t, "/api/v1/attendance/punch", tok, uuid.NewString(), map[string]any{
		"pin": pin, "action": "in", "photo": base64.StdEncoding.EncodeToString([]byte("не картинка")),
	})
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	if r.StatusCode != http.StatusOK {
		t.Fatalf("отметка должна пройти даже с битым снимком: %d %v", r.StatusCode, out)
	}
	if out["photo_saved"] != false {
		t.Fatalf("битый снимок не должен считаться сохранённым: %v", out)
	}
	var n int64
	gdb.Model(&models.TimeEntry{}).Where("user_id = ?", userID).Count(&n)
	if n != 1 {
		t.Fatalf("отметка не записалась: %d", n)
	}
	gdb.Model(&models.AttendancePhoto{}).Where("user_id = ?", userID).Count(&n)
	if n != 0 {
		t.Fatalf("битый снимок попал в БД: %d", n)
	}
}

// Отметка без снимка вообще (терминал без камеры или без разрешения).
func TestAttendancePhoto_OptionalWhenAbsent(t *testing.T) {
	f := setupE2E(t)
	gdb := openTestDB(t)
	tok := seedTerminal(t, f, gdb, "1111")

	waiter, name, pin := "waiter", "Без фото", "8811"
	gdb.Create(&models.User{ID: uuid.NewString(), Name: &name, Role: &waiter, PIN: &pin, RestaurantID: &f.rid})

	r, b := f.post(t, "/api/v1/attendance/punch", tok, uuid.NewString(), map[string]any{
		"pin": pin, "action": "in",
	})
	var out map[string]any
	_ = json.Unmarshal(b, &out)
	if r.StatusCode != http.StatusOK || out["action"] != "in" {
		t.Fatalf("отметка без снимка должна проходить: %d %v", r.StatusCode, out)
	}
	entryID, _ := out["entry_id"].(string)
	r, _ = f.get(t, "/api/v1/attendance/photo/"+entryID+"?kind=in", tok)
	if r.StatusCode != http.StatusNotFound {
		t.Fatalf("снимка нет — ожидали 404, получили %d", r.StatusCode)
	}
	_ = os.Remove(filepath.Join(t.TempDir(), "noop"))
}
