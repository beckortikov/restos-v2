package service

import (
	"context"
	"encoding/json"
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// EmployeeRelayService — узкий транспорт «central управляет сотрудником
// филиала» (владелец 2026-08-30, миграция 097). Учётка обязана физически
// существовать в БД её филиала — central не может писать в чужой Postgres
// напрямую. central кладёт pending-команду, филиал забирает своим пулером
// (EmployeeRelayPuller, employee_relay_pull.go) и материализует её через
// СВОИ, настоящие UsersService.Create/Patch/SalaryService.SetWorkedDays/
// ToggleDayMultiplier под синтетическим актором — так же, как delivery-relay
// (091) материализует заказ через настоящий OrdersService.Create.
//
// Payload для kind=create/update_identity/update_pay — это сериализованный
// UserInput (admin.go): Patch уже принимает identity- и pay-поля одним
// методом, отдельные структуры под каждый kind только дублировали бы поля.
// set_worked_days/toggle_day_multiplier — отдельные payload'ы, эти два
// SalaryService-метода принимают совсем другую форму (даты, не поля юзера).
type EmployeeRelayService struct {
	r *repo.Repo
}

func NewEmployeeRelayService(r *repo.Repo) *EmployeeRelayService {
	return &EmployeeRelayService{r: r}
}

// requireCentralOwner — дублирует NetworkService.requireCentralOwner
// (network_invites.go) — тот же приём, что и у DeliveryRelayService со своим
// независимым requireCentralAccount: гвард в 15 строк не стоит межсервисной
// зависимости. В отличие от delivery-relay (операционное действие, owner не
// обязателен) — здесь HR/деньги филиала, поэтому строго owner, как и у
// PayBranchSalary/RequestMoneyTransfer.
func (s *EmployeeRelayService) requireCentralOwner(ctx context.Context) (rid, account string, err error) {
	actor, _ := audit.ActorFromContext(ctx)
	if actor.Role != "owner" {
		return "", "", apperrors.Wrap("FORBIDDEN", "только владелец может управлять персоналом сети", nil)
	}
	rid, err = tenant.MustRestaurantID(ctx)
	if err != nil {
		return "", "", err
	}
	var rest models.Restaurant
	if err = s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&rest).Error; err != nil {
		return "", "", err
	}
	if rest.Kind == nil || *rest.Kind != "central_warehouse" {
		return "", "", apperrors.Wrap("VALIDATION", "управлять персоналом филиалов может только центральный узел сети", nil)
	}
	if rest.AccountID == nil || *rest.AccountID == "" {
		return "", "", apperrors.Wrap("VALIDATION", "ресторан не в сети", nil)
	}
	return rid, *rest.AccountID, nil
}

// branchInAccount — тот же гвард, что delivery_relay.go/network_payroll.go:
// целевой филиал реально принадлежит этой сети, не произвольный чужой id.
func (s *EmployeeRelayService) branchInAccount(ctx context.Context, account, branchID string) (*models.Restaurant, error) {
	var branch models.Restaurant
	if err := s.r.Raw().WithContext(ctx).
		Where("id = ? AND account_id = ?", branchID, account).
		First(&branch).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.Wrap("VALIDATION", "филиал не найден в этой сети", nil)
		}
		return nil, err
	}
	return &branch, nil
}

// dispatchAttribution — реальный central-пользователь (не синтетический
// актор филиала, который используется ТОЛЬКО при материализации, см.
// employee_relay_pull.go) — та же логика, что DeliveryRelayService.
func dispatchAttribution(ctx context.Context) (userID, userName *string) {
	if actor, ok := audit.ActorFromContext(ctx); ok {
		if actor.UserID != "" {
			userID = &actor.UserID
		}
		if actor.UserName != "" {
			userName = &actor.UserName
		}
	}
	return userID, userName
}

// pickPIN — advisory-подбор PIN для сотрудника ЧУЖОГО филиала: central видит
// его users только своей репликой (up-sync), отстающей до ~интервала синка
// от факта на филиале — поэтому НЕ авторитетно. Финальное слово всегда за
// филиалом: UsersService.Create там (Фаза 1, admin.go) отвергнет реальную
// коллизию явно (status=failed), а не тихо продублирует PIN. Публичный
// POST /users/generate-pin намеренно НЕ расширен на чужой tenant (Фаза 1,
// GeneratePIN) — это отдельный internal-путь именно для central→филиал.
func (s *EmployeeRelayService) pickPIN(ctx context.Context, branchID string) (string, error) {
	var used []string
	if err := s.r.Raw().WithContext(ctx).Model(&models.User{}).
		Where("restaurant_id = ? AND pin IS NOT NULL", branchID).
		Pluck("pin", &used).Error; err != nil {
		return "", err
	}
	usedSet := make(map[string]struct{}, len(used))
	for _, p := range used {
		usedSet[p] = struct{}{}
	}
	for attempt := 0; attempt < 200; attempt++ {
		n := 1000 + (timeNowNano() % 9000)
		pin := itoa4(int(n))
		if _, ok := usedSet[pin]; !ok {
			return pin, nil
		}
	}
	return "", apperrors.Wrap("CONFLICT", "не удалось подобрать свободный PIN", nil)
}

// resolveTargetUser — для update_identity/update_pay/set_worked_days/
// toggle_day_multiplier: central резолвит target_restaurant_id ИЗ уже
// реплицированной строки users по targetUserID, а не из клиентского поля —
// исключает рассинхрон user_id/branch_id (тот же приём, что PayBranchSalary,
// network_payroll.go). Отдельно отбивает свой же central (для своих
// сотрудников — обычный Patch, не relay).
func (s *EmployeeRelayService) resolveTargetUser(ctx context.Context, rid, account, targetUserID string) (*models.User, error) {
	if targetUserID == "" {
		return nil, apperrors.Wrap("VALIDATION", "укажите сотрудника", nil)
	}
	var user models.User
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", targetUserID).First(&user).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	if user.RestaurantID == nil || *user.RestaurantID == "" {
		return nil, apperrors.ErrNotFound
	}
	if *user.RestaurantID == rid {
		return nil, apperrors.Wrap("VALIDATION", "для своих сотрудников используйте обычное редактирование в Настройках", nil)
	}
	if _, err := s.branchInAccount(ctx, account, *user.RestaurantID); err != nil {
		return nil, err
	}
	return &user, nil
}

func (s *EmployeeRelayService) enqueue(ctx context.Context, rid, account, branchID, kind string, targetUserID *string, payload any) (*models.EmployeeRelayAction, error) {
	payloadJSON, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	userID, userName := dispatchAttribution(ctx)
	row := &models.EmployeeRelayAction{
		AccountID:          account,
		RestaurantID:       rid,
		TargetRestaurantID: branchID,
		TargetUserID:       targetUserID,
		Kind:               kind,
		Payload:            payloadJSON,
		Status:             "pending",
		CreatedByUserID:    userID,
		CreatedByName:      userName,
	}
	if err := s.r.Raw().WithContext(ctx).Create(row).Error; err != nil {
		return nil, err
	}
	return row, nil
}

// ─── Create ──────────────────────────────────────────────────────────────

// CreateEmployeeRelayInput — body POST /api/v1/employee-relay.
type CreateEmployeeRelayInput struct {
	BranchID    string  `json:"branch_id"`
	Name        string  `json:"name"`
	Username    *string `json:"username,omitempty"`
	Role        string  `json:"role"`
	Phone       *string `json:"phone,omitempty"`
	Email       *string `json:"email,omitempty"`
	Position    *string `json:"position,omitempty"`
	BirthDate   *string `json:"birth_date,omitempty"`
	Station     *string `json:"station,omitempty"`
	Salary      *string `json:"salary,omitempty"`
	HourlyRate  *string `json:"hourly_rate,omitempty"`
	PayType     *string `json:"pay_type,omitempty"`
	DailyRate   *string `json:"daily_rate,omitempty"`
	ShiftNumber *int    `json:"shift_number,omitempty"`
	// PIN — если не передан, central сам подбирает свободный (см. pickPIN).
	// Пароль намеренно отсутствует — единственный реальный вход в кассу это
	// PIN (AuthService.LoginByPIN), поле password везде дефолтится в БД.
	PIN *string `json:"pin,omitempty"`
}

// RequestCreate — central ставит в очередь создание сотрудника ДЛЯ ФИЛИАЛА.
// Учётка появится на филиале с задержкой ~интервал EmployeeRelayPuller, не
// сразу — см. CreateEmployeeRelayInput.
func (s *EmployeeRelayService) RequestCreate(ctx context.Context, in CreateEmployeeRelayInput) (*models.EmployeeRelayAction, error) {
	rid, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "users.manage"); err != nil {
		return nil, err
	}
	if in.BranchID == "" {
		return nil, apperrors.Wrap("VALIDATION", "укажите филиал", nil)
	}
	if in.BranchID == rid {
		return nil, apperrors.Wrap("VALIDATION", "для своих сотрудников используйте обычное добавление в Настройках", nil)
	}
	if in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	if in.Role == "" {
		return nil, apperrors.Wrap("VALIDATION", "role is required", nil)
	}
	if _, err := s.branchInAccount(ctx, account, in.BranchID); err != nil {
		return nil, err
	}

	pin := in.PIN
	if pin == nil || *pin == "" {
		p, err := s.pickPIN(ctx, in.BranchID)
		if err != nil {
			return nil, err
		}
		pin = &p
	}

	name, role := in.Name, in.Role
	payload := UserInput{
		Name: &name, Username: in.Username, PIN: pin, Role: &role,
		Phone: in.Phone, Email: in.Email, Position: in.Position, BirthDate: in.BirthDate,
		Station: in.Station, Salary: in.Salary, HourlyRate: in.HourlyRate,
		PayType: in.PayType, DailyRate: in.DailyRate, ShiftNumber: in.ShiftNumber,
	}
	return s.enqueue(ctx, rid, account, in.BranchID, "create", nil, payload)
}

// ─── Update identity / pay ───────────────────────────────────────────────

// RequestUpdateIdentity — central правит роль/PIN/логин/должность и т.п.
// уже существующего сотрудника филиала. in — тот же UserInput, что и
// обычный локальный PATCH /users/{id}: nil-поля не меняются.
func (s *EmployeeRelayService) RequestUpdateIdentity(ctx context.Context, targetUserID string, in UserInput) (*models.EmployeeRelayAction, error) {
	rid, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "users.manage"); err != nil {
		return nil, err
	}
	user, err := s.resolveTargetUser(ctx, rid, account, targetUserID)
	if err != nil {
		return nil, err
	}
	return s.enqueue(ctx, rid, account, *user.RestaurantID, "update_identity", &targetUserID, in)
}

// RequestUpdatePay — central правит ставку/оклад/тип оплаты уже
// существующего сотрудника филиала.
func (s *EmployeeRelayService) RequestUpdatePay(ctx context.Context, targetUserID string, in UserInput) (*models.EmployeeRelayAction, error) {
	rid, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	user, err := s.resolveTargetUser(ctx, rid, account, targetUserID)
	if err != nil {
		return nil, err
	}
	return s.enqueue(ctx, rid, account, *user.RestaurantID, "update_pay", &targetUserID, in)
}

// ─── Доп. смены ──────────────────────────────────────────────────────────

// SetWorkedDaysRelayInput — body POST /api/v1/employee-relay/{user_id}/worked-days.
type SetWorkedDaysRelayInput struct {
	From  string   `json:"from"`
	To    string   `json:"to"`
	Dates []string `json:"dates"`
}

// RequestSetWorkedDays — central отмечает доп. смены сотруднику филиала на
// дневной оплате (зеркало SalaryService.SetWorkedDays).
func (s *EmployeeRelayService) RequestSetWorkedDays(ctx context.Context, targetUserID string, in SetWorkedDaysRelayInput) (*models.EmployeeRelayAction, error) {
	rid, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	if in.From == "" || in.To == "" {
		return nil, apperrors.Wrap("VALIDATION", "from/to are required", nil)
	}
	user, err := s.resolveTargetUser(ctx, rid, account, targetUserID)
	if err != nil {
		return nil, err
	}
	return s.enqueue(ctx, rid, account, *user.RestaurantID, "set_worked_days", &targetUserID, in)
}

// ToggleDayMultiplierRelayInput — body POST /api/v1/employee-relay/{user_id}/day-multiplier.
type ToggleDayMultiplierRelayInput struct {
	Date string `json:"date"`
	From string `json:"from"`
	To   string `json:"to"`
}

// RequestToggleDayMultiplier — central отмечает «двойную смену» (×2) на
// конкретный день сотруднику филиала на гибридном окладе (зеркало
// SalaryService.ToggleDayMultiplier).
func (s *EmployeeRelayService) RequestToggleDayMultiplier(ctx context.Context, targetUserID string, in ToggleDayMultiplierRelayInput) (*models.EmployeeRelayAction, error) {
	rid, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	if in.Date == "" || in.From == "" || in.To == "" {
		return nil, apperrors.Wrap("VALIDATION", "date/from/to are required", nil)
	}
	user, err := s.resolveTargetUser(ctx, rid, account, targetUserID)
	if err != nil {
		return nil, err
	}
	return s.enqueue(ctx, rid, account, *user.RestaurantID, "toggle_day_multiplier", &targetUserID, in)
}

// ─── График смен (104) ───────────────────────────────────────────────────

// SetScheduleRelayInput — body POST /api/v1/employee-relay/{user_id}/schedule.
// Слоты в том же виде, что у локального ScheduleService.SetTemplate: PUT-
// семантика, снятые дни исчезают.
type SetScheduleRelayInput struct {
	Slots []TemplateSlotInput `json:"slots"`
}

// RequestSetSchedule — central задаёт недельный график сотруднику филиала.
func (s *EmployeeRelayService) RequestSetSchedule(ctx context.Context, targetUserID string, in SetScheduleRelayInput) (*models.EmployeeRelayAction, error) {
	rid, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	// Пустой список — это НЕ ошибка, а «снять график целиком»: сотрудник
	// больше не выходит по расписанию. Запрещать пришлось бы городить
	// отдельную команду ради того же результата.
	user, err := s.resolveTargetUser(ctx, rid, account, targetUserID)
	if err != nil {
		return nil, err
	}
	return s.enqueue(ctx, rid, account, *user.RestaurantID, "set_schedule", &targetUserID, in)
}

// SetScheduleDayRelayInput — body POST /api/v1/employee-relay/{user_id}/schedule-day.
type SetScheduleDayRelayInput struct {
	Date string `json:"date"`
	// Action: work | off | reset. reset снимает правку и возвращает день к
	// недельному шаблону — отдельным kind'ом это было бы третьей командой
	// ради одной строки в пуллере.
	Action   string  `json:"action"`
	StartsAt *string `json:"starts_at,omitempty"`
	EndsAt   *string `json:"ends_at,omitempty"`
	Note     *string `json:"note,omitempty"`
}

// RequestSetScheduleDay — central правит один день графика сотрудника филиала.
func (s *EmployeeRelayService) RequestSetScheduleDay(ctx context.Context, targetUserID string, in SetScheduleDayRelayInput) (*models.EmployeeRelayAction, error) {
	rid, account, err := s.requireCentralOwner(ctx)
	if err != nil {
		return nil, err
	}
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	if in.Date == "" {
		return nil, apperrors.Wrap("VALIDATION", "date is required", nil)
	}
	if in.Action != "work" && in.Action != "off" && in.Action != "reset" {
		return nil, apperrors.Wrap("VALIDATION", "action должен быть work, off или reset", nil)
	}
	user, err := s.resolveTargetUser(ctx, rid, account, targetUserID)
	if err != nil {
		return nil, err
	}
	return s.enqueue(ctx, rid, account, *user.RestaurantID, "set_schedule_day", &targetUserID, in)
}

// ─── История / очередь / ack ─────────────────────────────────────────────

// EmployeeRelayHistoryItem — одна строка истории (central), с человеко-
// читаемым именем филиала вместо голого id.
type EmployeeRelayHistoryItem struct {
	models.EmployeeRelayAction
	TargetRestaurantName string `json:"target_restaurant_name"`
}

// ListHistory — GET /api/v1/employee-relay/history?limit=N, central-сторона.
func (s *EmployeeRelayService) ListHistory(ctx context.Context, limit int) ([]EmployeeRelayHistoryItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if limit <= 0 || limit > 200 {
		limit = 50
	}
	var rows []models.EmployeeRelayAction
	if err := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ?", rid).
		Order("created_at DESC").
		Limit(limit).
		Find(&rows).Error; err != nil {
		return nil, err
	}
	out := make([]EmployeeRelayHistoryItem, 0, len(rows))
	if len(rows) == 0 {
		return out, nil
	}
	branchIDs := make([]string, 0, len(rows))
	seen := map[string]bool{}
	for _, r := range rows {
		if !seen[r.TargetRestaurantID] {
			seen[r.TargetRestaurantID] = true
			branchIDs = append(branchIDs, r.TargetRestaurantID)
		}
	}
	var branches []models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id IN ?", branchIDs).Find(&branches).Error; err != nil {
		return nil, err
	}
	nameByID := make(map[string]string, len(branches))
	for _, b := range branches {
		nameByID[b.ID] = b.Name
	}
	for _, r := range rows {
		out = append(out, EmployeeRelayHistoryItem{EmployeeRelayAction: r, TargetRestaurantName: nameByID[r.TargetRestaurantID]})
	}
	return out, nil
}

// ListPending — GET /api/v1/sync/employees/pending?restaurant_id=X, филиал.
func (s *EmployeeRelayService) ListPending(ctx context.Context, restaurantID string) ([]models.EmployeeRelayAction, error) {
	if restaurantID == "" {
		return nil, apperrors.Wrap("VALIDATION", "restaurant_id is required", nil)
	}
	var rows []models.EmployeeRelayAction
	if err := s.r.Raw().WithContext(ctx).
		Where("target_restaurant_id = ? AND status = ?", restaurantID, "pending").
		Order("created_at ASC").
		Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

// AckEmployeeRelayInput — body POST /api/v1/sync/employees/{id}/ack.
type AckEmployeeRelayInput struct {
	Status      string  `json:"status"` // delivered|failed
	LocalUserID *string `json:"local_user_id,omitempty"`
	Error       *string `json:"error,omitempty"`
}

// Ack — филиал подтверждает результат материализации. Идемпотентно, как
// DeliveryRelayService.Ack: повторный ack с тем же результатом — не ошибка.
func (s *EmployeeRelayService) Ack(ctx context.Context, id, restaurantID string, in AckEmployeeRelayInput) error {
	if in.Status != "delivered" && in.Status != "failed" {
		return apperrors.Wrap("VALIDATION", "status must be delivered or failed", nil)
	}
	now := time.Now().UTC()
	updates := map[string]any{"status": in.Status, "updated_at": now}
	if in.Status == "delivered" {
		updates["delivered_at"] = now
	}
	if in.LocalUserID != nil && *in.LocalUserID != "" {
		updates["local_user_id"] = *in.LocalUserID
	}
	if in.Error != nil {
		updates["error"] = *in.Error
	}
	q := s.r.Raw().WithContext(ctx).Model(&models.EmployeeRelayAction{}).Where("id = ?", id)
	if restaurantID != "" {
		q = q.Where("target_restaurant_id = ?", restaurantID)
	}
	res := q.Updates(updates)
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}
