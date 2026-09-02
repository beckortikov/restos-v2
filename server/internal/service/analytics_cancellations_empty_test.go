//go:build integration

package service_test

import (
	"context"
	"encoding/json"
	"strings"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// Владелец 2026-09-02: «если войти в раздел отмены в центральном выходит
// ошибка». Бэкенд отвечал 200, падал фронт: пустой разрез уходил как null,
// а BucketCard делает buckets.map.
//
// Воспроизводим состояние central: отменённые заказы есть, отмен позиций нет
// вовсе (order_voids пуст) — значит by_dish пуст. Он обязан быть [], не null.
func TestCancellationsReport_EmptyBucketsSerializeAsArrays(t *testing.T) {
	gdb, err := db.Open(transferTestDSN())
	if err != nil {
		t.Fatalf("db.Open: %v", err)
	}
	if err := db.MigrateUp(t.Context(), gdb); err != nil {
		t.Fatalf("migrate: %v", err)
	}
	t.Cleanup(func() {
		if sqlDB, err := gdb.DB(); err == nil {
			_ = sqlDB.Close()
		}
	})
	for _, tbl := range []string{"order_voids", "order_items", "orders", "users", "restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	rid := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: rid, Name: "Центральный"})

	now := time.Now().UTC()
	closed := "closed"
	reason := "Ошибка кухни"
	total := decimal.MustFromString("70")
	gdb.Create(&models.Order{
		ID: uuid.NewString(), Status: &closed, RestaurantID: &rid,
		Total: total, TotalWithService: total, ClosedAt: &now,
		CancelledAt: &now, CancelReason: &reason, CancelledTotal: &total,
		CreatedAt: now, UpdatedAt: now,
	})

	svc := service.NewAnalyticsService(repo.New(gdb))
	ctx := tenant.WithRestaurant(context.Background(), rid)
	from := now.Add(-1 * time.Hour)
	out, err := svc.CancellationsReport(ctx, service.CancellationFilter{PeriodFilter: service.PeriodFilter{From: &from}})
	if err != nil {
		t.Fatalf("CancellationsReport: %v", err)
	}
	if len(out.Summary.ByDish) != 0 {
		t.Fatalf("ByDish ожидался пустым (отмен позиций нет): %+v", out.Summary.ByDish)
	}

	b, err := json.Marshal(out.Summary)
	if err != nil {
		t.Fatalf("marshal: %v", err)
	}
	got := string(b)
	for _, field := range []string{"by_reason", "by_employee", "by_dish", "by_day"} {
		if strings.Contains(got, `"`+field+`":null`) {
			t.Errorf("%s пришёл как null — страница отмен упадёт на buckets.map; ответ: %s", field, got)
		}
	}
	if !strings.Contains(got, `"by_dish":[]`) {
		t.Errorf("by_dish должен быть пустым массивом; ответ: %s", got)
	}
}
