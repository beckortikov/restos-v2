//go:build integration

package service_test

import (
	"context"
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

// TestNetworkTimezone_PinnedToDushanbeRegardlessOfSession — владелец
// 2026-08-30: «в центральном пиковых часах нет заказов после 19:00... везде
// в центральном таймзона надо душанбе использовать». Central-VPS живёт в UTC
// (проверено: timedatectl → Etc/UTC), а Postgres-сессия наследует таймзону
// хоста при initdb — ни один коннекшн в этом проекте её явно не пиннит. Голый
// EXTRACT(HOUR FROM closed_at)/EXTRACT(DOW FROM closed_at) на UTC-сессии
// съезжал на −5ч и путал даты для локальных 00:00–04:59 (см. AT TIME ZONE
// 'Asia/Dushanbe' в PeakHours/WeekdayNetwork).
//
// Обычный dev-тест этого не поймает: локальный Postgres разработчика уже
// стоит в Asia/Dushanbe (initdb унаследовал ОС), и голый EXTRACT там и так
// «случайно» верный. Тест форсирует сессию тестовой БД на UTC (SET TIME ZONE
// + MaxOpenConns=1, чтобы Go не подменил соединение из пула) — воспроизводя
// ИМЕННО central-сценарий — и проверяет, что PeakHours/WeekdayNetwork всё
// равно возвращают душанбинские час/день, а не UTC-сдвинутые.
func TestNetworkTimezone_PinnedToDushanbeRegardlessOfSession(t *testing.T) {
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
	for _, tbl := range []string{"order_items", "orders", "menu_items", "restaurants", "company_accounts"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	// MaxOpenConns=1 — весь тест обязан ходить через ОДНО физическое соединение,
	// иначе Go молча возьмёт из пула другое (с дефолтной, не UTC, сессией) и
	// тест перестанет что-либо проверять.
	sqlDB, err := gdb.DB()
	if err != nil {
		t.Fatalf("gdb.DB: %v", err)
	}
	sqlDB.SetMaxOpenConns(1)
	sqlDB.SetMaxIdleConns(1)
	if err := gdb.Exec("SET TIME ZONE 'UTC'").Error; err != nil {
		t.Fatalf("SET TIME ZONE 'UTC': %v", err)
	}
	var sessionTZ string
	gdb.Raw("SHOW TIME ZONE").Scan(&sessionTZ)
	if sessionTZ != "UTC" {
		t.Fatalf("session timezone = %q, want UTC (тест не воспроизводит central-сценарий)", sessionTZ)
	}

	accountID := uuid.NewString()
	gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"})
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw})
	gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot})

	// Душанбинские локальные Суббота 01:00 — специально ПЕРЕСЕКАЮТ полночь:
	// под UTC-сессией без AT TIME ZONE это выглядело бы как Пятница 20:00
	// (весь символ бага #1/#3 из отчёта владельца — часы «после полуночи»
	// значатся под чужим днём и съезжают на −5ч).
	loc, err := time.LoadLocation("Asia/Dushanbe")
	if err != nil {
		t.Fatalf("LoadLocation: %v", err)
	}
	localClosed := time.Date(2026, 8, 29, 1, 0, 0, 0, loc) // Суббота 01:00 Душанбе
	closedAt := localClosed.UTC()                          // = Пятница 20:00 UTC

	closed, hall, cash := "closed", "hall", "cash"
	dishName, cat, station := "Плов", "Кухня", "hot_kitchen"
	miID := uuid.NewString()
	gdb.Create(&models.MenuItem{ID: miID, Name: &dishName, Category: &cat, Station: &station, RestaurantID: &branchID, Price: decimal.MustFromString("50"), UnitSize: decimal.MustFromString("1")})
	orderID := uuid.NewString()
	gdb.Create(&models.Order{
		ID: orderID, RestaurantID: &branchID, Status: &closed, Type: &hall, PaymentMethod: &cash,
		Total: decimal.MustFromString("50"), TotalWithService: decimal.MustFromString("50"), ClosedAt: &closedAt,
		CreatedAt: closedAt, UpdatedAt: closedAt,
	})
	piece, one := "piece", decimal.MustFromString("1")
	gdb.Create(&models.OrderItem{
		ID: uuid.NewString(), OrderID: &orderID, MenuItemID: &miID, Name: &dishName,
		Qty: one, Price: decimal.MustFromString("50"), Unit: &piece, UnitSize: one,
	})

	svc := service.NewNetworkService(repo.New(gdb), "")
	ctx := tenant.WithRestaurant(context.Background(), centralID)
	from := closedAt.Add(-2 * time.Hour)
	f := service.PeriodFilter{From: &from}

	t.Run("PeakHours", func(t *testing.T) {
		out, err := svc.PeakHours(ctx, f)
		if err != nil {
			t.Fatalf("PeakHours: %v", err)
		}
		if len(out.Cells) != 1 {
			t.Fatalf("len(Cells) = %d, want 1: %+v", len(out.Cells), out.Cells)
		}
		cell := out.Cells[0]
		// Postgres DOW: 0=Вс..6=Сб. Душанбинская суббота 01:00 → weekday=6, hour=1.
		// Без AT TIME ZONE под UTC-сессией получили бы weekday=5 (Пт), hour=20.
		if cell.Weekday != 6 || cell.Hour != 1 {
			t.Errorf("cell = {weekday=%d, hour=%d}, want {weekday=6, hour=1} (душанбинские Сб 01:00) — похоже, AT TIME ZONE 'Asia/Dushanbe' не применяется", cell.Weekday, cell.Hour)
		}
	})

	t.Run("WeekdayNetwork_Heatmap", func(t *testing.T) {
		out, err := svc.WeekdayNetwork(ctx, f)
		if err != nil {
			t.Fatalf("WeekdayNetwork: %v", err)
		}
		if len(out.Heatmap) != 1 {
			t.Fatalf("len(Heatmap) = %d, want 1: %+v", len(out.Heatmap), out.Heatmap)
		}
		cell := out.Heatmap[0]
		if cell.Weekday != 6 || cell.Hour != 1 {
			t.Errorf("heatmap cell = {weekday=%d, hour=%d}, want {weekday=6, hour=1}", cell.Weekday, cell.Hour)
		}
		// ByWeekday — тот же факт с другой стороны: revenue обязан лечь в
		// индекс 6 (Суббота), а не 5 (Пятница).
		if len(out.ByWeekday) != 7 {
			t.Fatalf("len(ByWeekday) = %d, want 7", len(out.ByWeekday))
		}
		if !out.ByWeekday[6].Revenue.Equal(decimal.MustFromString("50")) {
			t.Errorf("ByWeekday[6] (Суббота) Revenue = %s, want 50", out.ByWeekday[6].Revenue)
		}
		if !out.ByWeekday[5].Revenue.IsZero() {
			t.Errorf("ByWeekday[5] (Пятница) Revenue = %s, want 0 — заказ не должен был съехать на предыдущий день", out.ByWeekday[5].Revenue)
		}
	})
}
