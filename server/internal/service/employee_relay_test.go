//go:build integration

package service_test

import (
	"context"
	"net/http/httptest"
	"testing"

	"github.com/go-chi/chi/v5"
	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
	"github.com/restos/restos-v4/server/internal/service"
	"github.com/restos/restos-v4/server/internal/transport/http/handlers"
)

// Владелец 2026-08-30 (план «Центральное управление персоналом сети»,
// Фаза 2): central не может писать в БД филиала напрямую — каждая команда
// проходит очередь employee_relay_actions и материализуется НАСТОЯЩИМ
// UsersService.Create/Patch/SalaryService.SetWorkedDays/ToggleDayMultiplier
// на стороне филиала, вызванным EmployeeRelayPuller. Эти тесты гоняют
// пулер ПО-НАСТОЯЩЕМУ HTTP (httptest.Server + chi, как в проде — Ack читает
// {id} через chi.URLParam, голый ServeMux его не даст), чтобы payload'ы
// проходили реальный JSON round-trip, а не собирались вручную в памяти.

type employeeRelayFixture struct {
	gdb                 *gorm.DB
	relaySvc            *service.EmployeeRelayService
	puller              *service.EmployeeRelayPuller
	ctxCentral          context.Context
	centralID, branchID string
	accountID           string
}

func newEmployeeRelayFixture(t *testing.T) *employeeRelayFixture {
	t.Helper()
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
	for _, tbl := range []string{
		"employee_relay_received", "employee_relay_actions",
		"salary_day_multipliers", "salary_worked_days",
		"users", "restaurants", "company_accounts", "sync_settings",
	} {
		gdb.Exec("DELETE FROM " + tbl)
	}

	accountID := uuid.NewString()
	if err := gdb.Create(&models.CompanyAccount{ID: accountID, Name: "Сеть"}).Error; err != nil {
		t.Fatalf("seed account: %v", err)
	}
	centralID, branchID := uuid.NewString(), uuid.NewString()
	cw, ot := "central_warehouse", "outlet"
	if err := gdb.Create(&models.Restaurant{ID: centralID, Name: "Центр", AccountID: &accountID, Kind: &cw}).Error; err != nil {
		t.Fatalf("seed central: %v", err)
	}
	if err := gdb.Create(&models.Restaurant{ID: branchID, Name: "Филиал", AccountID: &accountID, Kind: &ot}).Error; err != nil {
		t.Fatalf("seed branch: %v", err)
	}

	relaySvc := service.NewEmployeeRelayService(repo.New(gdb))
	usersSvc := service.NewUsersService(repo.New(gdb))
	salarySvc := service.NewSalaryService(repo.New(gdb))

	relayH := handlers.NewEmployeeRelay(relaySvc)
	r := chi.NewRouter()
	r.Get("/api/v1/sync/employees/pending", relayH.Pending)
	r.Post("/api/v1/sync/employees/{id}/ack", relayH.Ack)
	srv := httptest.NewServer(r)
	t.Cleanup(srv.Close)
	// activeConfig без строки sync_settings падает на fallback (см.
	// employee_relay_pull.go) — таблицу оставляем пустой намеренно.
	scheduleSvc := service.NewScheduleService(repo.New(gdb), nil)
	puller := service.NewEmployeeRelayPuller(usersSvc, salarySvc, scheduleSvc, repo.New(gdb), service.PullerFallback{
		CentralURL: srv.URL, RestaurantID: branchID, Enabled: true,
	})

	owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
	ctxCentral := audit.WithActor(tenant.WithRestaurant(context.Background(), centralID), owner)

	return &employeeRelayFixture{
		gdb: gdb, relaySvc: relaySvc, puller: puller,
		ctxCentral: ctxCentral,
		centralID:  centralID, branchID: branchID, accountID: accountID,
	}
}

// TestEmployeeRelay_CreateMaterializesOnBranch — центр ставит create в
// очередь → пулер филиала реально создаёт users-строку на филиале (не на
// central!) через UsersService.Create, включая PIN — филиал должен принять
// его на ValidatePIN, как настоящий вход в кассу.
func TestEmployeeRelay_CreateMaterializesOnBranch(t *testing.T) {
	f := newEmployeeRelayFixture(t)

	name, role, pin := "Повар Филиала", "cook", "4321"
	action, err := f.relaySvc.RequestCreate(f.ctxCentral, service.CreateEmployeeRelayInput{
		BranchID: f.branchID, Name: name, Role: role, PIN: &pin,
	})
	if err != nil {
		t.Fatalf("RequestCreate: %v", err)
	}
	if action.Status != "pending" || action.Kind != "create" {
		t.Fatalf("action = %+v, want status=pending kind=create", action)
	}

	pending, err := f.relaySvc.ListPending(context.Background(), f.branchID)
	if err != nil {
		t.Fatalf("ListPending: %v", err)
	}
	if len(pending) != 1 || pending[0].ID != action.ID {
		t.Fatalf("ListPending = %+v, want 1 entry with id=%s", pending, action.ID)
	}

	delivered, err := f.puller.PullOnce(context.Background())
	if err != nil {
		t.Fatalf("PullOnce: %v", err)
	}
	if delivered != 1 {
		t.Fatalf("delivered = %d, want 1", delivered)
	}

	var branchUser models.User
	if err := f.gdb.Where("restaurant_id = ? AND name = ?", f.branchID, name).First(&branchUser).Error; err != nil {
		t.Fatalf("сотрудник не материализовался на филиале: %v", err)
	}
	if branchUser.Role == nil || *branchUser.Role != role {
		t.Errorf("role = %v, want %s", branchUser.Role, role)
	}
	if branchUser.PIN == nil || *branchUser.PIN != pin {
		t.Errorf("pin = %v, want %s", branchUser.PIN, pin)
	}

	// Реальный вход по PIN на филиале — не только запись в БД, а рабочая учётка.
	usersSvc := service.NewUsersService(repo.New(f.gdb))
	loggedIn, err := usersSvc.ValidatePIN(context.Background(), f.branchID, pin)
	if err != nil || loggedIn == nil || loggedIn.ID != branchUser.ID {
		t.Fatalf("ValidatePIN на филиале не нашёл созданного сотрудника: %v", err)
	}

	var acked models.EmployeeRelayAction
	if err := f.gdb.First(&acked, "id = ?", action.ID).Error; err != nil {
		t.Fatal(err)
	}
	if acked.Status != "delivered" {
		t.Errorf("status = %s, want delivered", acked.Status)
	}
	if acked.LocalUserID == nil || *acked.LocalUserID != branchUser.ID {
		t.Errorf("local_user_id = %v, want %s", acked.LocalUserID, branchUser.ID)
	}

	var receivedCnt int64
	f.gdb.Model(&models.EmployeeRelayReceived{}).Where("relay_action_id = ?", action.ID).Count(&receivedCnt)
	if receivedCnt != 1 {
		t.Errorf("employee_relay_received count = %d, want 1", receivedCnt)
	}
}

// TestEmployeeRelay_UpdateIdentityAndPay — правка УЖЕ существующего
// сотрудника филиала: identity через UsersService.Patch (роль/логин),
// pay отдельным вызовом (оклад) — тем же Patch, другой kind транспорта.
func TestEmployeeRelay_UpdateIdentityAndPay(t *testing.T) {
	f := newEmployeeRelayFixture(t)

	empName, empRole := "Официант", "waiter"
	empID := uuid.NewString()
	if err := f.gdb.Create(&models.User{ID: empID, Name: &empName, Role: &empRole, RestaurantID: &f.branchID}).Error; err != nil {
		t.Fatalf("seed employee: %v", err)
	}

	newRole, newUsername := "manager", "novyi_manager"
	if _, err := f.relaySvc.RequestUpdateIdentity(f.ctxCentral, empID, service.UserInput{
		Role: &newRole, Username: &newUsername,
	}); err != nil {
		t.Fatalf("RequestUpdateIdentity: %v", err)
	}
	newSalary := "8500.5000"
	if _, err := f.relaySvc.RequestUpdatePay(f.ctxCentral, empID, service.UserInput{
		Salary: &newSalary,
	}); err != nil {
		t.Fatalf("RequestUpdatePay: %v", err)
	}

	if delivered, err := f.puller.PullOnce(context.Background()); err != nil || delivered != 2 {
		t.Fatalf("PullOnce = %d, %v, want 2, nil", delivered, err)
	}

	var got models.User
	if err := f.gdb.First(&got, "id = ?", empID).Error; err != nil {
		t.Fatal(err)
	}
	if got.Role == nil || *got.Role != newRole {
		t.Errorf("role = %v, want %s", got.Role, newRole)
	}
	if got.Username == nil || *got.Username != newUsername {
		t.Errorf("username = %v, want %s", got.Username, newUsername)
	}
	if !got.Salary.Equal(decimal.MustFromString(newSalary)) {
		t.Errorf("salary = %s, want %s", got.Salary.String(), newSalary)
	}
}

// TestEmployeeRelay_WorkedDaysAndDayMultiplier — центр отмечает доп. смены и
// ×2-день сотруднику филиала на дневной оплате — оба типа команд бьют в
// SalaryService на СТОРОНЕ ФИЛИАЛА, не в central.
func TestEmployeeRelay_WorkedDaysAndDayMultiplier(t *testing.T) {
	f := newEmployeeRelayFixture(t)

	empName, empRole, daily := "Курьер", "waiter", "daily"
	empID := uuid.NewString()
	if err := f.gdb.Create(&models.User{
		ID: empID, Name: &empName, Role: &empRole, RestaurantID: &f.branchID, PayType: &daily,
	}).Error; err != nil {
		t.Fatalf("seed employee: %v", err)
	}

	from, to := "2026-08-01", "2026-08-31"
	if _, err := f.relaySvc.RequestSetWorkedDays(f.ctxCentral, empID, service.SetWorkedDaysRelayInput{
		From: from, To: to, Dates: []string{"2026-08-05", "2026-08-06"},
	}); err != nil {
		t.Fatalf("RequestSetWorkedDays: %v", err)
	}
	if _, err := f.relaySvc.RequestToggleDayMultiplier(f.ctxCentral, empID, service.ToggleDayMultiplierRelayInput{
		Date: "2026-08-05", From: from, To: to,
	}); err != nil {
		t.Fatalf("RequestToggleDayMultiplier: %v", err)
	}

	if delivered, err := f.puller.PullOnce(context.Background()); err != nil || delivered != 2 {
		t.Fatalf("PullOnce = %d, %v, want 2, nil", delivered, err)
	}

	// Проверяем ЧЕРЕЗ WorkedDays (реальный API филиала, тот же, которым его
	// собственная страница ЗП читает данные) — не сырым SELECT: work_date
	// это Postgres date, GORM/pgx сканирует такую колонку в Go string как
	// RFC3339 при обычном скане (сам WorkedDays поэтому кастует ::text явно).
	ctxBranch := tenant.WithRestaurant(context.Background(), f.branchID)
	salarySvc := service.NewSalaryService(repo.New(f.gdb))
	result, err := salarySvc.WorkedDays(ctxBranch, empID, from, to)
	if err != nil {
		t.Fatalf("WorkedDays на филиале: %v", err)
	}
	if len(result.ManualDates) != 2 || result.ManualDates[0] != "2026-08-05" || result.ManualDates[1] != "2026-08-06" {
		t.Errorf("manual_dates на филиале = %v, want [2026-08-05 2026-08-06]", result.ManualDates)
	}
	if result.Multipliers["2026-08-05"] != 2 {
		t.Errorf("multiplier на 2026-08-05 = %d, want 2 (множитель не применился на филиале)", result.Multipliers["2026-08-05"])
	}
}

// График смен филиала из центра (104): владелец сети задаёт недельный шаблон
// и точечно правит день, а филиал материализует это своим настоящим
// ScheduleService — тем же, которым пользуется его собственный менеджер.
func TestEmployeeRelay_ScheduleTemplateAndDay(t *testing.T) {
	f := newEmployeeRelayFixture(t)

	empName, empRole := "Сменщик", "cook"
	empID := uuid.NewString()
	if err := f.gdb.Create(&models.User{
		ID: empID, Name: &empName, Role: &empRole, RestaurantID: &f.branchID,
	}).Error; err != nil {
		t.Fatalf("seed employee: %v", err)
	}

	if _, err := f.relaySvc.RequestSetSchedule(f.ctxCentral, empID, service.SetScheduleRelayInput{
		Slots: []service.TemplateSlotInput{
			{Weekday: 1, StartsAt: "09:00", EndsAt: "18:00"},
			{Weekday: 2, StartsAt: "09:00", EndsAt: "18:00"},
		},
	}); err != nil {
		t.Fatalf("RequestSetSchedule: %v", err)
	}
	// Вторник — отгул вопреки шаблону.
	if _, err := f.relaySvc.RequestSetScheduleDay(f.ctxCentral, empID, service.SetScheduleDayRelayInput{
		Date: "2026-09-08", Action: "off",
	}); err != nil {
		t.Fatalf("RequestSetScheduleDay: %v", err)
	}

	if delivered, err := f.puller.PullOnce(context.Background()); err != nil || delivered != 2 {
		t.Fatalf("PullOnce = %d, %v, want 2, nil", delivered, err)
	}

	// Читаем через настоящий API филиала, а не сырым SELECT: план на дату —
	// это результат наложения override на шаблон, и проверять надо именно его.
	ctxBranch := audit.WithActor(
		tenant.WithRestaurant(context.Background(), f.branchID),
		audit.Actor{UserID: uuid.NewString(), Role: "owner"},
	)
	scheduleSvc := service.NewScheduleService(repo.New(f.gdb), nil)
	plan, err := scheduleSvc.Plan(ctxBranch, "2026-09-07", "2026-09-09", empID)
	if err != nil {
		t.Fatalf("Plan на филиале: %v", err)
	}
	byDate := map[string]service.PlannedShift{}
	for _, p := range plan {
		byDate[p.Date] = p
	}
	if got := byDate["2026-09-07"]; got.StartsAt != "09:00" || got.Source != "template" {
		t.Errorf("понедельник = %+v, want 09:00 из шаблона", got)
	}
	if got := byDate["2026-09-08"]; !got.IsOff || got.Source != "override" {
		t.Errorf("вторник = %+v, want отгул-override", got)
	}
	if _, ok := byDate["2026-09-09"]; ok {
		t.Errorf("среда не в шаблоне — строки быть не должно: %+v", byDate["2026-09-09"])
	}

	// Снятие правки возвращает день к шаблону; отсутствие правки при повторном
	// reset не ошибка — центр мог не знать, что менеджер филиала уже её убрал.
	for i := 0; i < 2; i++ {
		if _, err := f.relaySvc.RequestSetScheduleDay(f.ctxCentral, empID, service.SetScheduleDayRelayInput{
			Date: "2026-09-08", Action: "reset",
		}); err != nil {
			t.Fatalf("RequestSetScheduleDay reset #%d: %v", i+1, err)
		}
		if delivered, err := f.puller.PullOnce(context.Background()); err != nil || delivered != 1 {
			t.Fatalf("PullOnce reset #%d = %d, %v, want 1, nil", i+1, delivered, err)
		}
	}
	plan, err = scheduleSvc.Plan(ctxBranch, "2026-09-08", "2026-09-08", empID)
	if err != nil {
		t.Fatalf("Plan после reset: %v", err)
	}
	if len(plan) != 1 || plan[0].Source != "template" || plan[0].IsOff {
		t.Errorf("после reset вторник = %+v, want шаблонная смена", plan)
	}
}

// TestEmployeeRelay_GuardsRejectNonOwnerAndInvalidTargets — жёсткий
// owner-only гейт (как у PayBranchSalary/network_invites, requireCentralOwner)
// НЕЛЬЗЯ обойти явной выдачей users.manage/payroll.manage неvладельцу — это
// не обычная матрица прав, а межфилиальный HR/деньги. Плюс: не-central
// восстановитель и цель вне сети отклоняются валидацией.
func TestEmployeeRelay_GuardsRejectNonOwnerAndInvalidTargets(t *testing.T) {
	f := newEmployeeRelayFixture(t)
	name, role := "Х", "cashier"

	t.Run("manager с явным users.manage — всё равно FORBIDDEN, гейт строже матрицы прав", func(t *testing.T) {
		ctx := seedActor(t, f.gdb, f.centralID, "manager", `{"actions":{"users.manage":true,"payroll.manage":true}}`)
		if _, err := f.relaySvc.RequestCreate(ctx, service.CreateEmployeeRelayInput{BranchID: f.branchID, Name: name, Role: role}); err == nil {
			t.Error("want FORBIDDEN для не-owner, даже с явным users.manage")
		}
	})

	t.Run("owner, но вызывающий ресторан не central — VALIDATION", func(t *testing.T) {
		owner := audit.Actor{UserID: uuid.NewString(), Role: "owner"}
		ctxBranch := audit.WithActor(tenant.WithRestaurant(context.Background(), f.branchID), owner)
		if _, err := f.relaySvc.RequestCreate(ctxBranch, service.CreateEmployeeRelayInput{BranchID: f.branchID, Name: name, Role: role}); err == nil {
			t.Error("want VALIDATION — филиал не может диспетчеризовать сам себе")
		}
	})

	t.Run("branch_id вне сети — VALIDATION", func(t *testing.T) {
		if _, err := f.relaySvc.RequestCreate(f.ctxCentral, service.CreateEmployeeRelayInput{BranchID: uuid.NewString(), Name: name, Role: role}); err == nil {
			t.Error("want VALIDATION для чужого/несуществующего филиала")
		}
	})

	t.Run("branch_id == сам central — VALIDATION, обычное добавление в Настройках", func(t *testing.T) {
		if _, err := f.relaySvc.RequestCreate(f.ctxCentral, service.CreateEmployeeRelayInput{BranchID: f.centralID, Name: name, Role: role}); err == nil {
			t.Error("want VALIDATION для собственного ресторана central")
		}
	})

	t.Run("target_user_id из другой сети — VALIDATION", func(t *testing.T) {
		otherAccount := uuid.NewString()
		f.gdb.Create(&models.CompanyAccount{ID: otherAccount, Name: "Другая сеть"})
		foreignRid := uuid.NewString()
		ot := "outlet"
		f.gdb.Create(&models.Restaurant{ID: foreignRid, Name: "Чужой филиал", AccountID: &otherAccount, Kind: &ot})
		foreignName, foreignRole := "Чужой", "cashier"
		foreignUserID := uuid.NewString()
		f.gdb.Create(&models.User{ID: foreignUserID, Name: &foreignName, Role: &foreignRole, RestaurantID: &foreignRid})

		if _, err := f.relaySvc.RequestUpdatePay(f.ctxCentral, foreignUserID, service.UserInput{Salary: strPtr("100")}); err == nil {
			t.Error("want VALIDATION для сотрудника из другой сети")
		}
	})
}

// TestEmployeeRelay_IdempotentRedelivery — если ack не доехал до central
// (central-строка осталась/вернулась в pending), повторный тик пулера НЕ
// должен продублировать сотрудника — идемпотентность держится на
// employee_relay_received на филиале, не на статусе central.
func TestEmployeeRelay_IdempotentRedelivery(t *testing.T) {
	f := newEmployeeRelayFixture(t)
	name, role := "Разносчик", "waiter"
	action, err := f.relaySvc.RequestCreate(f.ctxCentral, service.CreateEmployeeRelayInput{BranchID: f.branchID, Name: name, Role: role})
	if err != nil {
		t.Fatalf("RequestCreate: %v", err)
	}

	if delivered, err := f.puller.PullOnce(context.Background()); err != nil || delivered != 1 {
		t.Fatalf("первый PullOnce = %d, %v, want 1, nil", delivered, err)
	}
	var cntAfterFirst int64
	f.gdb.Model(&models.User{}).Where("restaurant_id = ? AND name = ?", f.branchID, name).Count(&cntAfterFirst)
	if cntAfterFirst != 1 {
		t.Fatalf("сотрудников после первой доставки = %d, want 1", cntAfterFirst)
	}

	// Симулируем «ack не доехал»: central-строка возвращается в pending,
	// employee_relay_received на филиале остаётся как есть (реальный эффект
	// обрыва сети между обработкой и ack).
	if err := f.gdb.Model(&models.EmployeeRelayAction{}).Where("id = ?", action.ID).
		Update("status", "pending").Error; err != nil {
		t.Fatal(err)
	}

	if delivered, err := f.puller.PullOnce(context.Background()); err != nil || delivered != 1 {
		t.Fatalf("повторный PullOnce = %d, %v, want 1, nil (переотправка ack, не провал)", delivered, err)
	}
	var cntAfterSecond int64
	f.gdb.Model(&models.User{}).Where("restaurant_id = ? AND name = ?", f.branchID, name).Count(&cntAfterSecond)
	if cntAfterSecond != 1 {
		t.Errorf("сотрудников после повторной доставки = %d, want 1 (задвоение по недошедшему ack)", cntAfterSecond)
	}

	var acked models.EmployeeRelayAction
	f.gdb.First(&acked, "id = ?", action.ID)
	if acked.Status != "delivered" {
		t.Errorf("status после повторного ack = %s, want delivered", acked.Status)
	}
}

// TestEmployeeRelay_UsernameCollisionFailsGracefully — коллизия username на
// ФИЛИАЛЕ (Фаза 1, UsersService.Create) должна дойти до central читаемой
// ошибкой в status=failed, а не 500/паникой и не тихим дублем.
func TestEmployeeRelay_UsernameCollisionFailsGracefully(t *testing.T) {
	f := newEmployeeRelayFixture(t)
	existingName, existingRole, username := "Уже здесь", "cashier", "ivanov"
	if err := f.gdb.Create(&models.User{
		ID: uuid.NewString(), Name: &existingName, Role: &existingRole, RestaurantID: &f.branchID, Username: &username,
	}).Error; err != nil {
		t.Fatalf("seed existing: %v", err)
	}

	newName, newRole := "Новенький", "cook"
	action, err := f.relaySvc.RequestCreate(f.ctxCentral, service.CreateEmployeeRelayInput{
		BranchID: f.branchID, Name: newName, Role: newRole, Username: &username,
	})
	if err != nil {
		t.Fatalf("RequestCreate: %v", err)
	}

	delivered, err := f.puller.PullOnce(context.Background())
	if err != nil {
		t.Fatalf("PullOnce вернул ошибку транспорта (не должен — коллизия это failed одной команды, не сбой пула): %v", err)
	}
	if delivered != 0 {
		t.Fatalf("delivered = %d, want 0 (команда должна провалиться)", delivered)
	}

	var acked models.EmployeeRelayAction
	if err := f.gdb.First(&acked, "id = ?", action.ID).Error; err != nil {
		t.Fatal(err)
	}
	if acked.Status != "failed" {
		t.Fatalf("status = %s, want failed", acked.Status)
	}
	if acked.Error == nil || *acked.Error == "" {
		t.Error("error пустой — central не увидит причину отказа")
	}

	var cnt int64
	f.gdb.Model(&models.User{}).Where("restaurant_id = ? AND username = ?", f.branchID, username).Count(&cnt)
	if cnt != 1 {
		t.Errorf("сотрудников с username=%s на филиале = %d, want 1 (дубль не должен был создаться)", username, cnt)
	}
}
