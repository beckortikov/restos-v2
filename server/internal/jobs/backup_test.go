package jobs

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func TestClassifyTier(t *testing.T) {
	cases := []struct {
		date string
		want string
	}{
		{"2026-05-01T12:00:00Z", "monthly"}, // 1-е число
		{"2026-05-03T12:00:00Z", "weekly"},  // воскресенье 03.05.2026
		{"2026-05-05T12:00:00Z", "daily"},   // вторник
	}
	for _, c := range cases {
		t0, _ := time.Parse(time.RFC3339, c.date)
		got := classifyTier(t0)
		if got != c.want {
			t.Errorf("%s: got %s want %s", c.date, got, c.want)
		}
	}
}

func TestRotate(t *testing.T) {
	dir := t.TempDir()
	// Создаём 10 фейковых daily-файлов с разными timestamp.
	for i := 0; i < 10; i++ {
		name := "daily-2026010" + string(rune('0'+i)) + "-030000.dump"
		if err := os.WriteFile(filepath.Join(dir, name), []byte("x"), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	if err := rotate(dir, "daily", 3); err != nil {
		t.Fatal(err)
	}
	entries, _ := os.ReadDir(dir)
	count := 0
	for _, e := range entries {
		if strings.HasPrefix(e.Name(), "daily-") {
			count++
		}
	}
	if count != 3 {
		t.Errorf("after rotate kept %d, want 3", count)
	}
}

func TestDefaultNextRunAt(t *testing.T) {
	// 14:00 — следующий запуск в 03:00 завтра.
	now, _ := time.Parse(time.RFC3339, "2026-05-25T14:00:00Z")
	next := DefaultNextRunAt(now)
	if next.Hour() != 3 || next.Day() != 26 {
		t.Errorf("at 14:00 next should be 03:00 next day, got %s", next)
	}

	// 01:00 — следующий запуск в 03:00 сегодня.
	now2, _ := time.Parse(time.RFC3339, "2026-05-25T01:00:00Z")
	next2 := DefaultNextRunAt(now2)
	if next2.Hour() != 3 || next2.Day() != 25 {
		t.Errorf("at 01:00 next should be 03:00 same day, got %s", next2)
	}
}
