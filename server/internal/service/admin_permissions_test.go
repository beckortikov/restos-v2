//go:build integration

package service_test

import (
	"context"
	"testing"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
)

// Владелец 2026-08-30 (план «Центральное управление персоналом сети», Фаза 1):
// UsersService.Create/Patch/Delete раньше не проверяли права ВООБЩЕ — матрица
// была чисто клиентской, официант мог завести себе owner-учётку прямым POST
// в обход UI. Эти тесты фиксируют новый серверный гейт + попутно найденные
// дыры (уникальность username/PIN, кросс-тенантный GeneratePIN).

// seedActor — контекст с реальным DB-пользователем нужной роли (не owner —
// owner в hasPermFor коротит проверку до чтения БД, см. orders_perms.go:26).
func seedActor(t *testing.T, gdbRaw *gorm.DB, rid, role string, permissionsJSON string) context.Context {
	t.Helper()
	userID := uuid.NewString()
	u := &models.User{ID: userID, Name: strPtrPerm("Тест"), Role: &role, RestaurantID: &rid}
	if permissionsJSON != "" {
		u.Permissions = datatypes.JSON([]byte(permissionsJSON))
	}
	if err := gdbRaw.Create(u).Error; err != nil {
		t.Fatalf("seed actor: %v", err)
	}
	actor := audit.Actor{UserID: userID, Role: role}
	return audit.WithActor(tenant.WithRestaurant(context.Background(), rid), actor)
}

func strPtrPerm(s string) *string { return &s }

func TestUsersCreate_RequiresPermission(t *testing.T) {
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
	rid := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: rid, Name: "Тест"})

	svc := service.NewUsersService(repo.New(gdb))
	name, role := "Новый", "cashier"

	t.Run("no permission → FORBIDDEN", func(t *testing.T) {
		ctx := seedActor(t, gdb, rid, "cashier", "") // дефолт cashier — без users.manage
		_, err := svc.Create(ctx, service.UserInput{Name: &name, Role: &role})
		if err == nil {
			t.Fatal("want FORBIDDEN, got nil error — гейт не сработал")
		}
	})

	t.Run("users.manage → allowed", func(t *testing.T) {
		ctx := seedActor(t, gdb, rid, "cashier", `{"actions":{"users.manage":true}}`)
		u, err := svc.Create(ctx, service.UserInput{Name: &name, Role: &role})
		if err != nil {
			t.Fatalf("Create с users.manage: %v", err)
		}
		if u == nil || u.ID == "" {
			t.Fatal("создан пустой user")
		}
	})

	t.Run("owner → allowed без явного permissions", func(t *testing.T) {
		ctx := seedActor(t, gdb, rid, "owner", "")
		if _, err := svc.Create(ctx, service.UserInput{Name: &name, Role: &role}); err != nil {
			t.Fatalf("Create от owner: %v", err)
		}
	})
}

func TestUsersPatch_EitherPermissionAllowed(t *testing.T) {
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
	rid := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: rid, Name: "Тест"})
	targetName, targetRole := "Цель", "cook"
	targetID := uuid.NewString()
	gdb.Create(&models.User{ID: targetID, Name: &targetName, Role: &targetRole, RestaurantID: &rid})

	svc := service.NewUsersService(repo.New(gdb))
	newRole := "cashier"

	t.Run("neither permission → FORBIDDEN", func(t *testing.T) {
		ctx := seedActor(t, gdb, rid, "cashier", "")
		if _, err := svc.Patch(ctx, targetID, service.UserInput{Role: &newRole}); err == nil {
			t.Fatal("want FORBIDDEN")
		}
	})

	t.Run("только payroll.manage (identity-поле) → allowed — Patch не разделяет identity/pay", func(t *testing.T) {
		ctx := seedActor(t, gdb, rid, "cashier", `{"actions":{"payroll.manage":true}}`)
		if _, err := svc.Patch(ctx, targetID, service.UserInput{Role: &newRole}); err != nil {
			t.Fatalf("Patch с payroll.manage: %v", err)
		}
	})

	t.Run("только users.manage (pay-поле) → allowed — та же причина", func(t *testing.T) {
		salary := "5000"
		ctx := seedActor(t, gdb, rid, "cashier", `{"actions":{"users.manage":true}}`)
		if _, err := svc.Patch(ctx, targetID, service.UserInput{Salary: &salary}); err != nil {
			t.Fatalf("Patch с users.manage: %v", err)
		}
	})
}

func TestUsersDelete_RequiresPermission(t *testing.T) {
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
	rid := uuid.NewString()
	gdb.Create(&models.Restaurant{ID: rid, Name: "Тест"})
	targetName, targetRole := "Цель", "cook"
	targetID := uuid.NewString()
	gdb.Create(&models.User{ID: targetID, Name: &targetName, Role: &targetRole, RestaurantID: &rid})

	svc := service.NewUsersService(repo.New(gdb))

	// payroll.manage одного НЕ хватает на Delete — это HR-действие, не деньги.
	ctxPayrollOnly := seedActor(t, gdb, rid, "cashier", `{"actions":{"payroll.manage":true}}`)
	if err := svc.Delete(ctxPayrollOnly, targetID); err == nil {
		t.Error("Delete с одним payroll.manage должен быть FORBIDDEN")
	}

	ctxUsersManage := seedActor(t, gdb, rid, "cashier", `{"actions":{"users.manage":true}}`)
	if err := svc.Delete(ctxUsersManage, targetID); err != nil {
		t.Fatalf("Delete с users.manage: %v", err)
	}
}

func TestUsersCreate_RejectsDuplicateUsernameAndPIN(t *testing.T) {
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
	ridA, ridB := uuid.NewString(), uuid.NewString()
	gdb.Create(&models.Restaurant{ID: ridA, Name: "А"})
	gdb.Create(&models.Restaurant{ID: ridB, Name: "Б"})

	svc := service.NewUsersService(repo.New(gdb))
	name1, role1 := "Первый", "cashier"
	username, pin := "ivanov", "7777"
	ctxA := seedActor(t, gdb, ridA, "cashier", `{"actions":{"users.manage":true}}`)
	if _, err := svc.Create(ctxA, service.UserInput{Name: &name1, Role: &role1, Username: &username, PIN: &pin}); err != nil {
		t.Fatalf("первый Create: %v", err)
	}

	name2, role2 := "Второй", "waiter"
	t.Run("тот же username на том же ресторане → CONFLICT", func(t *testing.T) {
		dup := username
		if _, err := svc.Create(ctxA, service.UserInput{Name: &name2, Role: &role2, Username: &dup}); err == nil {
			t.Fatal("want CONFLICT на дублирующемся username")
		}
	})

	t.Run("тот же PIN на том же ресторане → CONFLICT", func(t *testing.T) {
		dup := pin
		if _, err := svc.Create(ctxA, service.UserInput{Name: &name2, Role: &role2, PIN: &dup}); err == nil {
			t.Fatal("want CONFLICT на дублирующемся PIN")
		}
	})

	t.Run("тот же username/PIN на ДРУГОМ ресторане → OK", func(t *testing.T) {
		ctxB := seedActor(t, gdb, ridB, "cashier", `{"actions":{"users.manage":true}}`)
		u2, err := svc.Create(ctxB, service.UserInput{Name: &name2, Role: &role2, Username: &username, PIN: &pin})
		if err != nil {
			t.Fatalf("Create на другом ресторане с тем же username/PIN: %v", err)
		}
		if u2 == nil {
			t.Fatal("создан пустой user")
		}
	})
}

func TestGeneratePIN_IgnoresForeignRestaurantID(t *testing.T) {
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
	ridOwn, ridOther := uuid.NewString(), uuid.NewString()
	gdb.Create(&models.Restaurant{ID: ridOwn, Name: "Свой"})
	gdb.Create(&models.Restaurant{ID: ridOther, Name: "Чужой"})

	// На "чужом" ресторане заняты ВСЕ PIN кроме одного — раньше передача
	// restaurantID=ridOther заставляла usedPINs всегда возвращаться ПУСТЫМ
	// (AND двух несовместимых restaurant_id), метод "находил свободным" PIN,
	// который на самом деле уже занят на СВОЁМ ресторане. Тест сеет коллизию
	// именно на СВОЁМ ресторане (ridOwn) — а не на ridOther — чтобы отличить
	// «игнорирует restaurantID» от «случайно совпало».
	usedRole := "cashier"
	pinVal := "1234"
	gdb.Create(&models.User{ID: uuid.NewString(), Name: strPtrPerm("Занял"), Role: &usedRole, RestaurantID: &ridOwn, PIN: &pinVal})

	svc := service.NewUsersService(repo.New(gdb))
	ctx := tenant.WithRestaurant(context.Background(), ridOwn)

	// Передаём ЧУЖОЙ restaurantID явно — метод обязан игнорировать его и
	// проверять СВОЙ tenant (ridOwn), где "1234" уже занят.
	for i := 0; i < 50; i++ {
		pin, err := svc.GeneratePIN(ctx, ridOther)
		if err != nil {
			t.Fatalf("GeneratePIN: %v", err)
		}
		if pin == pinVal {
			t.Fatalf("GeneratePIN вернул уже занятый на своём ресторане PIN %q — restaurantID=%q чужого ресторана не должен был на это повлиять (но раньше маскировал проверку)", pin, ridOther)
		}
	}
}
