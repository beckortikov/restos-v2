//go:build integration

package service_test

import (
	"testing"

	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
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
