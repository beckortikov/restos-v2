//go:build integration

package printer_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/printer"
)

func testDSN() string {
	return "host=127.0.0.1 port=5432 user=restos dbname=restos_v4_test sslmode=disable"
}

func setupQueue(t *testing.T) *gorm.DB {
	t.Helper()
	gdb, err := db.Open(testDSN())
	if err != nil {
		t.Fatal(err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatal(err)
	}
	if err := gdb.Exec("DELETE FROM print_jobs").Error; err != nil {
		t.Fatal(err)
	}
	return gdb
}

// TestQueue_HappyPath — pending job → tick → mock получает payload, status=done.
func TestQueue_HappyPath(t *testing.T) {
	gdb := setupQueue(t)
	mock := printer.NewMock()
	q := printer.NewQueue(gdb, printer.SingleRouter{P: mock}, printer.QueueConfig{
		PollInterval: 100 * time.Millisecond,
		MaxAttempts:  3,
		BaseBackoff:  50 * time.Millisecond,
	})

	rid := uuid.NewString()
	payload := []byte{0x1B, 0x40, 'H', 'i'} // ESC @ + "Hi"
	if err := gdb.Create(&models.PrintJob{
		ID:           uuid.NewString(),
		Type:         "receipt",
		Payload:      payload,
		Status:       "pending",
		RestaurantID: &rid,
		CreatedAt:    time.Now().UTC().Add(-time.Hour), // создан давно, backoff неактуален
		UpdatedAt:    time.Now().UTC().Add(-time.Hour),
	}).Error; err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go q.Run(ctx)

	// Ждём, пока job сменит статус.
	deadline := time.Now().Add(1500 * time.Millisecond)
	for time.Now().Before(deadline) {
		var got models.PrintJob
		gdb.First(&got, "status = ?", "done")
		if got.ID != "" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}

	payloads := mock.Payloads()
	if len(payloads) != 1 {
		t.Fatalf("mock got %d payloads, want 1", len(payloads))
	}
	if string(payloads[0]) != string(payload) {
		t.Errorf("payload mismatch: got %x want %x", payloads[0], payload)
	}

	var done models.PrintJob
	if err := gdb.First(&done, "payload = ?", payload).Error; err != nil {
		t.Fatal(err)
	}
	if done.Status != "done" {
		t.Errorf("status = %s, want done", done.Status)
	}
	if done.PrintedAt == nil {
		t.Errorf("printed_at not set")
	}
}

// TestQueue_RetryOnFailure — Send падает, attempts++, eventually failed.
func TestQueue_RetryOnFailure(t *testing.T) {
	gdb := setupQueue(t)
	mock := printer.NewMock()
	q := printer.NewQueue(gdb, printer.SingleRouter{P: mock}, printer.QueueConfig{
		PollInterval: 50 * time.Millisecond,
		MaxAttempts:  2,
		BaseBackoff:  10 * time.Millisecond, // быстрый backoff для теста
	})

	rid := uuid.NewString()
	mock.FailNext = true // первый Send упадёт; FailNext сбрасывается → второй пройдёт

	if err := gdb.Create(&models.PrintJob{
		ID:           uuid.NewString(),
		Type:         "receipt",
		Payload:      []byte{0x1B, 0x40},
		Status:       "pending",
		RestaurantID: &rid,
		CreatedAt:    time.Now().UTC().Add(-time.Hour),
		UpdatedAt:    time.Now().UTC().Add(-time.Hour),
	}).Error; err != nil {
		t.Fatal(err)
	}

	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	go q.Run(ctx)

	// Ждём done (после retry).
	deadline := time.Now().Add(1500 * time.Millisecond)
	var done models.PrintJob
	for time.Now().Before(deadline) {
		gdb.First(&done, "status = ?", "done")
		if done.ID != "" {
			break
		}
		time.Sleep(50 * time.Millisecond)
	}
	if done.ID == "" {
		t.Fatal("job did not succeed after retry")
	}
	if done.Attempts < 1 {
		t.Errorf("attempts = %d, want >= 1", done.Attempts)
	}
}
