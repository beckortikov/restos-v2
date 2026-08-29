//go:build integration

package service_test

import (
	"bytes"
	"testing"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// TestBootstrapOwnerUsername — владелец, созданный через Bootstrap
// (setup-central.sh на VPS, «Создать сеть» на кассе), обязан получить
// непустой Username. Поле само по себе косметическое (логин везде по PIN,
// не по username), но settings/users требует его непустым для кнопки
// «Сохранить» — без значения владелец не мог отредактировать вообще ничего
// в своей карточке, включая смену PIN (жалоба 2026-08-25, воспроизведено на
// central-VPS, созданном именно этим путём).
func TestBootstrapOwnerUsername(t *testing.T) {
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
	for _, tbl := range []string{"users", "restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	svc := service.NewBootstrapService(repo.New(gdb))
	out, err := svc.Run(t.Context(), service.BootstrapInput{
		RestaurantName: "Моя сеть", OwnerName: "Владелец", OwnerPIN: "1234",
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}
	if out.Owner.Username == nil || *out.Owner.Username == "" {
		t.Error("Owner.Username пуст — Сохранить в settings/users будет навсегда недоступен")
	}
}

// TestBootstrap_RecordsUserSync — владелец, созданный bootstrap'ом ПРЯМО НА
// ФИЛИАЛЕ (в отличие от приглашения с central, где central и так уже знает
// свой users), обязан попасть в sync_log — иначе central никогда не узнаёт о
// нём (та же дыра покрытия, что у Delete/ImportUsers, найдено 2026-08-29).
func TestBootstrap_RecordsUserSync(t *testing.T) {
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
	for _, tbl := range []string{"sync_log", "users", "restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}
	synclog.SetEnabled(true)
	t.Cleanup(func() { synclog.SetEnabled(false) })

	svc := service.NewBootstrapService(repo.New(gdb))
	out, err := svc.Run(t.Context(), service.BootstrapInput{
		RestaurantName: "Моя сеть", OwnerName: "Владелец", OwnerPIN: "1234",
	})
	if err != nil {
		t.Fatalf("Run: %v", err)
	}

	var rows []models.SyncLog
	if err := gdb.Where("table_name = ? AND row_id = ?", "users", out.Owner.ID).Find(&rows).Error; err != nil {
		t.Fatalf("query sync_log: %v", err)
	}
	if len(rows) != 1 {
		t.Fatalf("sync_log rows = %d, want 1", len(rows))
	}
	if rows[0].Op != "insert" {
		t.Errorf("Op = %q, want insert", rows[0].Op)
	}
	if bytes.Contains(rows[0].Payload, []byte(`"pin"`)) {
		t.Errorf("PIN не должен попадать в sync_log payload (json:\"-\"): %s", rows[0].Payload)
	}
}
