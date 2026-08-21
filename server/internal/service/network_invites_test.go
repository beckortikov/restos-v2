//go:build integration

package service_test

import (
	"context"
	"testing"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// TestNetworkInvites_CreateListRevoke — генерация/список/отзыв кодов на
// central: owner+kind-гварды, переиспользование сохранённого public_url.
func TestNetworkInvites_CreateListRevoke(t *testing.T) {
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
	for _, tbl := range []string{"restaurants", "company_accounts", "network_invites"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	centralID := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: centralID, Name: "Central"}).Error; err != nil {
		t.Fatal(err)
	}
	outletID := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: outletID, Name: "Outlet"}).Error; err != nil {
		t.Fatal(err)
	}

	svc := service.NewNetworkService(repo.New(gdb), "")
	ownerCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), audit.Actor{UserName: "owner", Role: "owner"})
	cashierCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), audit.Actor{UserName: "cashier", Role: "cashier"})
	ownerOutlet := audit.WithActor(tenant.WithRestaurant(context.Background(), outletID), audit.Actor{UserName: "owner", Role: "owner"})

	// Не-owner — отказ.
	if _, err := svc.CreateInvite(cashierCentral, "", "https://c.example.com"); err == nil {
		t.Error("non-owner should not create invite")
	}
	// Ресторан ещё не в сети (outlet вне account) — отказ.
	if _, err := svc.CreateInvite(ownerOutlet, "", "https://c.example.com"); err == nil {
		t.Error("restaurant outside network should not create invite")
	}

	// Central ещё не выпустил сеть на себя — заводим.
	if _, err := svc.CreateNetwork(ownerCentral, "Тест-сеть"); err != nil {
		t.Fatalf("CreateNetwork: %v", err)
	}

	// Первый инвайт без сохранённого public_url — обязателен явно.
	if _, err := svc.CreateInvite(ownerCentral, "", ""); err == nil {
		t.Error("first invite without public_url should error")
	}

	inv1, err := svc.CreateInvite(ownerCentral, "Филиал на Чехова", "https://c.example.com")
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}
	if inv1.Code == "" || inv1.PairingURL != "https://c.example.com/pair/"+inv1.Code {
		t.Errorf("unexpected invite: %+v", inv1)
	}

	// Второй инвайт БЕЗ public_url — переиспользует сохранённый.
	inv2, err := svc.CreateInvite(ownerCentral, "", "")
	if err != nil {
		t.Fatalf("CreateInvite (reuse url): %v", err)
	}
	if inv2.PairingURL != "https://c.example.com/pair/"+inv2.Code {
		t.Errorf("second invite did not reuse stored public_url: %+v", inv2)
	}
	if inv1.Code == inv2.Code {
		t.Error("codes must be unique")
	}

	list, err := svc.ListInvites(ownerCentral)
	if err != nil {
		t.Fatalf("ListInvites: %v", err)
	}
	if len(list) != 2 {
		t.Fatalf("ListInvites len = %d, want 2", len(list))
	}

	if err := svc.RevokeInvite(ownerCentral, inv1.ID); err != nil {
		t.Fatalf("RevokeInvite: %v", err)
	}
	if err := svc.RevokeInvite(ownerCentral, inv1.ID); err == nil {
		t.Error("revoking already-revoked invite should error")
	}
	list, err = svc.ListInvites(ownerCentral)
	if err != nil {
		t.Fatalf("ListInvites after revoke: %v", err)
	}
	if len(list) != 1 {
		t.Fatalf("ListInvites after revoke len = %d, want 1", len(list))
	}
}

// TestNetworkInvites_Redeem — обмен кода на central: happy path, повторный
// обмен (уже использован), истёкший код, несуществующий код.
func TestNetworkInvites_Redeem(t *testing.T) {
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
	for _, tbl := range []string{"restaurants", "company_accounts", "network_invites", "sync_settings"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	centralID := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: centralID, Name: "Central"}).Error; err != nil {
		t.Fatal(err)
	}
	// Общий секрет сети. С Фазы Г он БОЛЬШЕ НЕ выдаётся филиалам (каждый
	// получает свой, см. ниже), но остаётся принимаемым для касс, подключённых
	// раньше, — поэтому сервис его по-прежнему знает.
	tok := "test-sync-token-123"
	svc := service.NewNetworkService(repo.New(gdb), tok)
	ownerCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), audit.Actor{UserName: "owner", Role: "owner"})
	acc, err := svc.CreateNetwork(ownerCentral, "Тест-сеть")
	if err != nil {
		t.Fatalf("CreateNetwork: %v", err)
	}
	inv, err := svc.CreateInvite(ownerCentral, "", "https://c.example.com")
	if err != nil {
		t.Fatalf("CreateInvite: %v", err)
	}

	// Несуществующий код.
	if _, err := svc.RedeemInvite(context.Background(), "NOSUCHCODE", "", ""); err == nil {
		t.Error("unknown code should error")
	}

	// Happy path.
	branchID := uuid.NewString()
	res, err := svc.RedeemInvite(context.Background(), inv.Code, branchID, "Филиал X")
	if err != nil {
		t.Fatalf("RedeemInvite: %v", err)
	}
	// Фаза Г: филиалу выдаётся ПЕРСОНАЛЬНЫЙ секрет, а не общий секрет сети.
	// Пока он был общим, central не мог отличить узлы друг от друга — и,
	// в частности, по-настоящему отключить филиал.
	if res.Token == tok {
		t.Error("выдан ОБЩИЙ секрет сети — филиалы снова неотличимы друг от друга")
	}
	if len(res.Token) < 32 {
		t.Errorf("персональный токен подозрительно короткий: %d символов", len(res.Token))
	}
	// На central хранится только ХЕШ токена, сам токен ему не нужен.
	var stored models.Restaurant
	if err := gdb.First(&stored, "id = ?", branchID).Error; err != nil {
		t.Fatal(err)
	}
	if stored.SyncTokenHash == nil || *stored.SyncTokenHash != service.HashSyncToken(res.Token) {
		t.Error("хеш персонального токена не сохранён — SyncAuth не опознает филиал")
	}
	if *stored.SyncTokenHash == res.Token {
		t.Error("токен сохранён в открытом виде вместо хеша")
	}
	if res.AccountID != acc.ID {
		t.Errorf("account_id = %q, want %q", res.AccountID, acc.ID)
	}
	if res.CentralName != "Central" {
		t.Errorf("central_name = %q, want Central", res.CentralName)
	}

	// Регресс-пруф: central обязан завести теневую запись restaurants для
	// филиала при погашении кода — иначе ListBranches/branchesForAccount
	// (Warehouse, PnL, Cashflow) никогда его не найдут, сколько бы ingest
	// потом ни присылал данных с его restaurant_id (найдено вживую — филиал
	// подключился, данные не появлялись в сетевых отчётах никогда).
	branches, err := svc.ListBranches(ownerCentral)
	if err != nil {
		t.Fatalf("ListBranches: %v", err)
	}
	var found bool
	for _, b := range branches {
		if b.ID == branchID {
			found = true
			if b.Name != "Филиал X" {
				t.Errorf("branch name = %q, want «Филиал X»", b.Name)
			}
			if b.Kind == nil || *b.Kind != "outlet" {
				t.Errorf("branch kind = %v, want outlet", b.Kind)
			}
		}
	}
	if !found {
		t.Error("филиал не появился в ListBranches после RedeemInvite — central не завёл теневую запись restaurants")
	}

	// Повторный обмен того же кода — конфликт.
	if _, err := svc.RedeemInvite(context.Background(), inv.Code, "", ""); err == nil {
		t.Error("re-redeeming used code should error")
	}

	// Истёкший код — вставляем строку напрямую с expires_at в прошлом.
	now := time.Now().UTC()
	expired := &models.NetworkInvite{
		ID: uuid.NewString(), AccountID: acc.ID, Code: "EXPIREDCODE1",
		CreatedAt: now, ExpiresAt: now.Add(-time.Hour),
	}
	if err := gdb.Create(expired).Error; err != nil {
		t.Fatalf("seed expired invite: %v", err)
	}
	if _, err := svc.RedeemInvite(context.Background(), "EXPIREDCODE1", "", ""); err == nil {
		t.Error("expired code should error")
	}
}

// TestNetworkInvites_JoinNetworkGuards — owner/kind-гварды и разбор кода на
// стороне филиала, без реального сетевого похода на central (это отдельно
// проверяется живым двухузловым прогоном — central и branch в проде это
// физически разные БД, sync_settings — синглтон на процесс, честно
// смоделировать оба конца в одной тестовой БД нельзя).
func TestNetworkInvites_JoinNetworkGuards(t *testing.T) {
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
	for _, tbl := range []string{"restaurants"} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	branchID := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: branchID, Name: "Branch"}).Error; err != nil {
		t.Fatal(err)
	}
	cw := "central_warehouse"
	centralID := uuid.NewString()
	if err := gdb.Create(&models.Restaurant{ID: centralID, Name: "Central", Kind: &cw}).Error; err != nil {
		t.Fatal(err)
	}

	svc := service.NewNetworkService(repo.New(gdb), "")
	cashierBranch := audit.WithActor(tenant.WithRestaurant(context.Background(), branchID), audit.Actor{UserName: "cashier", Role: "cashier"})
	ownerBranch := audit.WithActor(tenant.WithRestaurant(context.Background(), branchID), audit.Actor{UserName: "owner", Role: "owner"})
	ownerCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), audit.Actor{UserName: "owner", Role: "owner"})

	if _, err := svc.JoinNetwork(cashierBranch, "https://c.example.com/pair/ABC"); err == nil {
		t.Error("non-owner should not join network")
	}
	if _, err := svc.JoinNetwork(ownerCentral, "https://c.example.com/pair/ABC"); err == nil {
		t.Error("central_warehouse should not join a network")
	}
	if _, err := svc.JoinNetwork(ownerBranch, "not-a-valid-pairing-string"); err == nil {
		t.Error("malformed pairing code should error")
	}
	if _, err := svc.JoinNetwork(ownerBranch, "https://c.example.com/pair/"); err == nil {
		t.Error("empty code segment should error")
	}
}
