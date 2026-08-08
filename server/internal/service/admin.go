// Admin CRUD для служебных сущностей: users, customers, suppliers,
// reservations, restaurant settings.
//
// Все методы идут через ForTenant. PATCH использует map[string]any updates
// чтобы pointer-семантика (nil = не менять).
package service

import (
	"context"
	"encoding/json"
	"errors"
	"strings"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"
	"gorm.io/gorm/clause"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/pkg/timeutil"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ─── Users ─────────────────────────────────────────────────────────────────

type UsersService struct{ r *repo.Repo }

func NewUsersService(r *repo.Repo) *UsersService { return &UsersService{r: r} }

// UserInput — body POST/PATCH /api/v1/users. На PATCH nil поля не меняются.
type UserInput struct {
	Username   *string `json:"username,omitempty"`
	Name       *string `json:"name,omitempty"`
	PIN        *string `json:"pin,omitempty"`
	Password   *string `json:"password,omitempty"`
	Role       *string `json:"role,omitempty"` // cashier|cook|waiter|manager|owner
	Phone      *string `json:"phone,omitempty"`
	Email      *string `json:"email,omitempty"`
	Position   *string `json:"position,omitempty"`
	BirthDate  *string `json:"birth_date,omitempty"`
	Station    *string `json:"station,omitempty"`
	Salary     *string `json:"salary,omitempty"`
	HourlyRate *string `json:"hourly_rate,omitempty"`
	// Тип оплаты труда (054): monthly (оклад) | daily (ставка за день).
	PayType     *string          `json:"pay_type,omitempty"`
	DailyRate   *string          `json:"daily_rate,omitempty"`
	Advance     *string          `json:"advance,omitempty"`
	Deductions  *string          `json:"deductions,omitempty"`
	ShiftNumber *int             `json:"shift_number,omitempty"`
	Permissions *json.RawMessage `json:"permissions,omitempty"`
}

// UsersFilter — опциональные фильтры для List.
type UsersFilter struct {
	// RestaurantID — если непустой, фильтрует по конкретному ресторану.
	// Иначе — по tenant из JWT через ForTenant.
	RestaurantID string
}

func (s *UsersService) List(ctx context.Context, f UsersFilter) ([]models.User, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	q := scoped
	if f.RestaurantID != "" {
		q = q.Where("restaurant_id = ?", f.RestaurantID)
	}
	// Soft-deleted (role='deleted') скрываем из list — фронт не знает
	// этот псевдо-роль и крашится на ROLE_DEFAULT_PERMISSIONS['deleted'].
	q = q.Where("role IS NULL OR role <> ?", "deleted")
	var rows []models.User
	// PIN/password защищены json:"-" на модели — сериализация их скроет.
	if err := q.Order("role ASC, name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *UsersService) Get(ctx context.Context, id string) (*models.User, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var u models.User
	if err := scoped.Where("id = ?", id).First(&u).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &u, nil
}

func (s *UsersService) Create(ctx context.Context, in UserInput) (*models.User, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	if in.Role == nil || *in.Role == "" {
		return nil, apperrors.Wrap("VALIDATION", "role is required", nil)
	}
	now := time.Now().UTC()
	u := &models.User{
		ID: uuid.NewString(), Name: in.Name, Role: in.Role,
		Username: in.Username, PIN: in.PIN, Password: in.Password,
		Phone: in.Phone, Email: in.Email, Position: in.Position, Station: in.Station,
		RestaurantID: &rid, CreatedAt: now, UpdatedAt: now,
	}
	if in.Salary != nil {
		d, err := decimal.FromString(*in.Salary)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad salary", err)
		}
		u.Salary = d
	}
	if in.HourlyRate != nil {
		d, err := decimal.FromString(*in.HourlyRate)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad hourly_rate", err)
		}
		u.HourlyRate = d
	}
	if in.PayType != nil {
		if *in.PayType != PayTypeMonthly && *in.PayType != PayTypeDaily {
			return nil, apperrors.Wrap("VALIDATION", "pay_type must be monthly|daily", nil)
		}
		pt := *in.PayType
		u.PayType = &pt
	}
	if in.DailyRate != nil {
		d, err := decimal.FromString(*in.DailyRate)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad daily_rate", err)
		}
		if decimal.IsNegative(d) {
			return nil, apperrors.Wrap("VALIDATION", "daily_rate must be >= 0", nil)
		}
		u.DailyRate = d
	}
	if in.Advance != nil {
		d, err := decimal.FromString(*in.Advance)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad advance", err)
		}
		u.Advance = d
	}
	if in.Deductions != nil {
		d, err := decimal.FromString(*in.Deductions)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad deductions", err)
		}
		u.Deductions = d
	}
	if in.ShiftNumber != nil {
		u.ShiftNumber = in.ShiftNumber
	}
	if in.BirthDate != nil {
		u.BirthDate = in.BirthDate
	}
	if in.Permissions != nil && len(*in.Permissions) > 0 {
		u.Permissions = datatypes.JSON(*in.Permissions)
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(u).Error; err != nil {
		return nil, err
	}
	return u, nil
}

func (s *UsersService) Patch(ctx context.Context, id string, in UserInput) (*models.User, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.User
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Username != nil {
		updates["username"] = *in.Username
	}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.PIN != nil {
		updates["pin"] = *in.PIN
	}
	if in.Password != nil {
		updates["password"] = *in.Password
	}
	if in.Role != nil {
		updates["role"] = *in.Role
	}
	if in.Phone != nil {
		updates["phone"] = *in.Phone
	}
	if in.Email != nil {
		updates["email"] = *in.Email
	}
	if in.Position != nil {
		updates["position"] = *in.Position
	}
	if in.Station != nil {
		updates["station"] = *in.Station
	}
	if in.Salary != nil {
		d, err := decimal.FromString(*in.Salary)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad salary", err)
		}
		updates["salary"] = d
	}
	if in.HourlyRate != nil {
		d, err := decimal.FromString(*in.HourlyRate)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad hourly_rate", err)
		}
		updates["hourly_rate"] = d
	}
	if in.PayType != nil {
		if *in.PayType != PayTypeMonthly && *in.PayType != PayTypeDaily {
			return nil, apperrors.Wrap("VALIDATION", "pay_type must be monthly|daily", nil)
		}
		updates["pay_type"] = *in.PayType
	}
	if in.DailyRate != nil {
		d, err := decimal.FromString(*in.DailyRate)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad daily_rate", err)
		}
		if decimal.IsNegative(d) {
			return nil, apperrors.Wrap("VALIDATION", "daily_rate must be >= 0", nil)
		}
		updates["daily_rate"] = d
	}
	if in.Advance != nil {
		d, err := decimal.FromString(*in.Advance)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad advance", err)
		}
		updates["advance"] = d
	}
	if in.Deductions != nil {
		d, err := decimal.FromString(*in.Deductions)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad deductions", err)
		}
		updates["deductions"] = d
	}
	if in.ShiftNumber != nil {
		updates["shift_number"] = *in.ShiftNumber
	}
	if in.BirthDate != nil {
		updates["birth_date"] = *in.BirthDate
	}
	if in.Permissions != nil && len(*in.Permissions) > 0 {
		updates["permissions"] = datatypes.JSON(*in.Permissions)
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	return s.Get(ctx, id)
}

// GeneratePIN — POST /api/v1/users/generate-pin.
// Возвращает случайный 4-значный PIN, не занятый ни одним юзером в текущем
// ресторане (или в указанном restaurant_id, если передан). Сам PIN никуда
// не сохраняется — клиент должен передать его в Create/Patch отдельно.
func (s *UsersService) GeneratePIN(ctx context.Context, restaurantID string) (string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return "", err
	}
	q := scoped.Model(&models.User{}).Where("pin IS NOT NULL")
	if restaurantID != "" {
		q = q.Where("restaurant_id = ?", restaurantID)
	}
	var used []string
	if err := q.Pluck("pin", &used).Error; err != nil {
		return "", err
	}
	usedSet := make(map[string]struct{}, len(used))
	for _, p := range used {
		usedSet[p] = struct{}{}
	}
	for attempt := 0; attempt < 200; attempt++ {
		// 4-digit PIN, 1000..9999 inclusive.
		n := 1000 + (timeNowNano() % 9000)
		pin := ""
		// преобразование в строку без strconv ради единого импорта
		// (не критично — используем простую конкатенацию).
		pin = itoa4(int(n))
		if _, ok := usedSet[pin]; !ok {
			return pin, nil
		}
	}
	return "", apperrors.Wrap("CONFLICT", "could not generate unique PIN — too many users", nil)
}

func timeNowNano() int64 { return time.Now().UTC().UnixNano() }

func itoa4(n int) string {
	if n < 0 {
		n = -n
	}
	b := []byte{'0', '0', '0', '0'}
	for i := 3; i >= 0 && n > 0; i-- {
		b[i] = byte('0' + (n % 10))
		n /= 10
	}
	return string(b)
}

// ValidatePIN — POST /api/v1/users/validate-pin.
// Constant-time сравнение PIN внутри ресторана; возвращает безопасный user
// (без PIN/password — модель использует json:"-").
// Используется PIN-lock screen'ом для повторной разблокировки в той же сессии,
// чтобы клиент не получал PIN всех юзеров.
func (s *UsersService) ValidatePIN(ctx context.Context, restaurantID, pin string) (*models.User, error) {
	if pin == "" {
		return nil, apperrors.Wrap("VALIDATION", "pin is required", nil)
	}
	var q *gorm.DB
	scoped, err := s.r.ForTenant(ctx)
	if err == nil {
		q = scoped.Where("pin IS NOT NULL")
		if restaurantID != "" {
			q = q.Where("restaurant_id = ?", restaurantID)
		}
	} else {
		// Fallback для публичного вызова (без JWT токена)
		if restaurantID == "" {
			return nil, apperrors.Wrap("VALIDATION", "restaurant_id is required for public pin validation", nil)
		}
		q = s.r.Raw().WithContext(ctx).Where("restaurant_id = ? AND pin IS NOT NULL", restaurantID)
	}
	var matches []models.User
	if err := q.Find(&matches).Error; err != nil {
		return nil, err
	}
	var found *models.User
	for i := range matches {
		if matches[i].PIN != nil && *matches[i].PIN == pin {
			if found != nil {
				return nil, apperrors.Wrap("UNAUTHORIZED", "invalid credentials", nil)
			}
			found = &matches[i]
		}
	}
	if found == nil {
		return nil, apperrors.ErrNotFound
	}
	return found, nil
}

// listWithoutDeleted — общий фильтр: исключаем soft-deleted пользователей
// из всех list-запросов. Frontend ROLE_DEFAULT_PERMISSIONS не знает role
// 'deleted' и крашится при попытке отрендерить.
//
// Delete — мягкое удаление через установку role='deleted'.
// Hard delete опасен: order.waiter_id ссылается через FK без cascade
// в legacy схеме. Эта семантика согласована с frontend.
func (s *UsersService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Model(&models.User{}).Where("id = ?", id).
		Updates(map[string]any{"role": "deleted", "updated_at": time.Now().UTC()})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ─── Customers ─────────────────────────────────────────────────────────────

type CustomersService struct{ r *repo.Repo }

func NewCustomersService(r *repo.Repo) *CustomersService { return &CustomersService{r: r} }

type CustomerInput struct {
	Name      *string `json:"name,omitempty"`
	Phone     *string `json:"phone,omitempty"`
	Email     *string `json:"email,omitempty"`
	BirthDate *string `json:"birth_date,omitempty"`
	Notes     *string `json:"notes,omitempty"`
}

type CustomersFilter struct {
	Query string
	Page  cursor.Page
}

func (s *CustomersService) List(ctx context.Context, f CustomersFilter) ([]models.Customer, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped
	if f.Query != "" {
		q = q.Where("name ILIKE ? OR phone ILIKE ?", "%"+f.Query+"%", "%"+f.Query+"%")
	}
	q = cursor.Apply(q, "customers", f.Page)
	var rows []models.Customer
	if err := q.Find(&rows).Error; err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trim, next := cursor.Next(rows, limit, func(m models.Customer) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trim, next, nil
}

func (s *CustomersService) Create(ctx context.Context, in CustomerInput) (*models.Customer, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if (in.Name == nil || *in.Name == "") && (in.Phone == nil || *in.Phone == "") {
		return nil, apperrors.Wrap("VALIDATION", "name or phone is required", nil)
	}
	now := time.Now().UTC()
	c := &models.Customer{
		ID:   uuid.NewString(),
		Name: in.Name, Phone: in.Phone, Email: in.Email,
		BirthDate: in.BirthDate, Notes: in.Notes,
		RestaurantID: &rid, CreatedAt: now,
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(c).Error; err != nil {
		return nil, err
	}
	return c, nil
}

func (s *CustomersService) Patch(ctx context.Context, id string, in CustomerInput) (*models.Customer, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Customer
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Phone != nil {
		updates["phone"] = *in.Phone
	}
	if in.Email != nil {
		updates["email"] = *in.Email
	}
	if in.BirthDate != nil {
		updates["birth_date"] = *in.BirthDate
	}
	if in.Notes != nil {
		updates["notes"] = *in.Notes
	}
	if len(updates) == 0 {
		return &existing, nil
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.Customer
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

// CustomerStatsInput — body POST /api/v1/customers/{id}/stats.
type CustomerStatsInput struct {
	OrderTotal *string `json:"order_total,omitempty"`
}

// IncrementStats — добавляет один заказ к visits_count и order_total к total_spent.
// Пересчитывает avg_check.
func (s *CustomersService) IncrementStats(ctx context.Context, id string, in CustomerStatsInput) (*models.Customer, error) {
	if in.OrderTotal == nil || *in.OrderTotal == "" {
		return nil, apperrors.Wrap("VALIDATION", "order_total is required", nil)
	}
	amount, err := decimal.FromString(*in.OrderTotal)
	if err != nil {
		return nil, apperrors.Wrap("VALIDATION", "bad order_total", err)
	}
	var out models.Customer
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		scoped, err := tr.ForTenant(ctx)
		if err != nil {
			return err
		}
		var c models.Customer
		if err := scoped.Where("id = ?", id).First(&c).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		newCount := 1
		if c.VisitsCount != nil {
			newCount = *c.VisitsCount + 1
		}
		newSpent := decimal.Normalize(decimal.Add(c.TotalSpent, amount))
		newAvg := decimal.Normalize(decimal.DivRound(newSpent, decimal.FromInt(int64(newCount))))
		now := time.Now().UTC()
		scoped2, _ := tr.ForTenant(ctx)
		if err := scoped2.Model(&c).Updates(map[string]any{
			"visits_count":  newCount,
			"total_spent":   newSpent,
			"avg_check":     newAvg,
			"last_visit_at": now,
		}).Error; err != nil {
			return err
		}
		scoped3, _ := tr.ForTenant(ctx)
		if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *CustomersService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.Customer{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ─── Suppliers ─────────────────────────────────────────────────────────────

type SuppliersService struct{ r *repo.Repo }

func NewSuppliersService(r *repo.Repo) *SuppliersService { return &SuppliersService{r: r} }

type SupplierInput struct {
	Name             *string  `json:"name,omitempty"`
	ContactPerson    *string  `json:"contact_person,omitempty"`
	Phone            *string  `json:"phone,omitempty"`
	Categories       []string `json:"categories,omitempty"`
	PaymentTermsDays *int     `json:"payment_terms_days,omitempty"`
	CreditLimit      *string  `json:"credit_limit,omitempty"`
}

func (s *SuppliersService) List(ctx context.Context) ([]models.Supplier, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var rows []models.Supplier
	if err := scoped.Order("name ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *SuppliersService) Create(ctx context.Context, in SupplierInput) (*models.Supplier, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.Name == nil || *in.Name == "" {
		return nil, apperrors.Wrap("VALIDATION", "name is required", nil)
	}
	now := time.Now().UTC()
	sup := &models.Supplier{
		ID: uuid.NewString(), Name: in.Name, ContactPerson: in.ContactPerson, Phone: in.Phone,
		PaymentTermsDays: in.PaymentTermsDays,
		RestaurantID:     &rid, CreatedAt: now, UpdatedAt: now,
	}
	if in.Categories != nil {
		b, _ := json.Marshal(in.Categories)
		sup.Categories = datatypes.JSON(b)
	}
	if in.CreditLimit != nil {
		d, err := decimal.FromString(*in.CreditLimit)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad credit_limit", err)
		}
		sup.CreditLimit = d
	}
	scoped, _ := s.r.ForTenant(ctx)
	if err := scoped.Create(sup).Error; err != nil {
		return nil, err
	}
	return sup, nil
}

func (s *SuppliersService) Patch(ctx context.Context, id string, in SupplierInput) (*models.Supplier, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing models.Supplier
	if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.ContactPerson != nil {
		updates["contact_person"] = *in.ContactPerson
	}
	if in.Phone != nil {
		updates["phone"] = *in.Phone
	}
	if in.Categories != nil {
		b, _ := json.Marshal(in.Categories)
		updates["categories"] = datatypes.JSON(b)
	}
	if in.PaymentTermsDays != nil {
		updates["payment_terms_days"] = *in.PaymentTermsDays
	}
	if in.CreditLimit != nil {
		d, err := decimal.FromString(*in.CreditLimit)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad credit_limit", err)
		}
		updates["credit_limit"] = d
	}
	scoped2, _ := s.r.ForTenant(ctx)
	if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
		return nil, err
	}
	scoped3, _ := s.r.ForTenant(ctx)
	var out models.Supplier
	if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
		return nil, err
	}
	return &out, nil
}

func (s *SuppliersService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.Supplier{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// SupplierPayDebtInput — тело POST /suppliers/{id}/pay-debt.
type SupplierPayDebtInput struct {
	Amount    string `json:"amount"`
	AccountID string `json:"account_id"`
}

// RecomputeDebts пересчитывает current_debt ВСЕХ поставщиков из первоисточника:
//
//	current_debt = Σ(stock_receipts.debt_amount данного поставщика)
//
// debt_amount — ОСТАТОК долга накладной: PayDebt раскладывает оплату по
// накладным (allocateDebtPayment), возврат уменьшает её же. Поэтому вычитать
// оплаты отдельно больше не нужно.
//
// До v3.16.89 формула была «Σ debt_amount − Σ оплат (category='supplier_payment'
// по counterparty)», а debt_amount оставался НАЧИСЛЕННЫМ навсегда. Из-за этого
// экран «Накладные» завышал «Задолженность», карточка поставщика показывала два
// разных долга рядом, а сверка оплат ломалась при переименовании поставщика
// (matching шёл по counterparty = имени). Миграция 043 разложила прошлые оплаты
// по накладным, так что суммарный долг поставщика не изменился — изменилось
// только его распределение.
//
// Нужен, когда денормализованное поле разошлось с реальностью: миграция бэкфилла
// не отработала после восстановления из бэкапа / обновления со старой версии.
// Это ручной само-ремонт «в один клик» — не полагаемся на одноразовую миграцию.
// Каст обеих сторон к text — против дрейфа типов uuid/text.
// GREATEST(0,…) — долг не уходит в минус. Возвращает число обновлённых строк.
func (s *SuppliersService) RecomputeDebts(ctx context.Context) (int64, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return 0, err
	}
	res := s.r.Raw().WithContext(ctx).Exec(`
		UPDATE suppliers s SET
		  current_debt = GREATEST(0,
		    COALESCE((SELECT SUM(sr.debt_amount) FROM stock_receipts sr
		              WHERE sr.supplier_id::text = s.id::text), 0)
		  ),
		  updated_at = now()
		WHERE s.restaurant_id = ?`, rid)
	if res.Error != nil {
		return 0, res.Error
	}
	return res.RowsAffected, nil
}

// allocateDebtPayment раскладывает оплату долга по накладным поставщика FIFO
// (старые сначала), уменьшая stock_receipts.debt_amount.
//
// Зачем: до этого оплата уменьшала только suppliers.current_debt, а накладная
// помнила начисленный долг вечно. «Сколько ещё должны по этой накладной» было
// неизвестно в принципе, и все экраны, показывавшие debt_amount как долг, врали.
// FIFO — самая честная раскладка без привязки платежа к накладной в UI: гасим
// то, что просрочено раньше.
func allocateDebtPayment(tx *gorm.DB, rid, supplierID string, amount decimal.Decimal, now time.Time) error {
	if !decimal.IsPositive(amount) {
		return nil
	}
	var receipts []models.StockReceipt
	if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
		Where("restaurant_id = ? AND supplier_id = ? AND debt_amount > 0", rid, supplierID).
		Order("created_at, id").Find(&receipts).Error; err != nil {
		return err
	}
	left := amount
	for i := range receipts {
		if !decimal.IsPositive(left) {
			break
		}
		cut := receipts[i].DebtAmount
		if left.LessThan(cut) {
			cut = left
		}
		if err := tx.Model(&receipts[i]).Updates(map[string]any{
			"debt_amount": decimal.Normalize(decimal.Sub(receipts[i].DebtAmount, cut)),
			"updated_at":  now,
		}).Error; err != nil {
			return err
		}
		left = decimal.Sub(left, cut)
	}
	return nil
}

// PayDebt — гашение долга поставщику. Атомарно: списывает сумму со счёта,
// уменьшает supplier.current_debt, создаёт financial_operation out
// category='supplier_payment'. Это гашение обязательства, а НЕ операционный
// расход (расход признаётся как COGS при продаже товара), поэтому категория
// исключена из opex ОПиУ. Переплатить долг нельзя (сумма клампится к остатку).
func (s *SuppliersService) PayDebt(ctx context.Context, id string, in SupplierPayDebtInput) (*models.Supplier, error) {
	// Гашение долга списывает деньги со счёта — серверная проверка обязательна.
	// Экран поставщика гейта canDo не имеет (закрыт навигацией), поэтому берём
	// оба права, которыми эту операцию делают в жизни: кладовщик ведёт
	// поставщиков, бухгалтер — деньги. Одного suppliers.manage мало: он есть у
	// кладовщика, но не у бухгалтера, и тот перестал бы платить по долгам.
	if !hasPermFor(ctx, s.r, "suppliers.manage") && !hasPermFor(ctx, s.r, "finance.manage") {
		return nil, apperrors.Wrap("FORBIDDEN", "недостаточно прав для гашения долга поставщику", nil)
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	amount, err := decimal.FromString(in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be > 0", err)
	}
	if in.AccountID == "" {
		return nil, apperrors.Wrap("VALIDATION", "account_id is required", nil)
	}
	now := time.Now().UTC()
	var out *models.Supplier
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var sup models.Supplier
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, id).First(&sup).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		if !decimal.IsPositive(sup.CurrentDebt) {
			return apperrors.Wrap("CONFLICT", "no outstanding debt", nil)
		}
		pay := amount
		if pay.GreaterThan(sup.CurrentDebt) {
			pay = sup.CurrentDebt // не переплачиваем долг
		}
		// Порядок замков (см. orders_perms.go): поставщик → накладные → счёт.
		// Раскладку делаем ДО блокировки счёта: раньше было наоборот, и получался
		// AB-BA с возвратом (он берёт накладную и тянется к поставщику) — одновременные
		// «оплатить долг» и «возврат» вешали друг друга насмерть.
		if err := allocateDebtPayment(tx, rid, sup.ID, pay, now); err != nil {
			return err
		}
		var acc models.FinancialAccount
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, in.AccountID).First(&acc).Error; err != nil {
			return apperrors.Wrap("VALIDATION", "account not found", err)
		}
		if !acc.IsEnabled {
			return apperrors.Wrap("CONFLICT", "счёт отключён — выберите другой счёт", nil)
		}
		newBal := decimal.Normalize(decimal.Sub(acc.Balance, pay))
		if decimal.IsNegative(newBal) {
			return apperrors.Wrap("CONFLICT", "insufficient funds on account", nil)
		}
		if err := tx.Model(&acc).Updates(map[string]any{"balance": newBal, "updated_at": now}).Error; err != nil {
			return err
		}
		sup.CurrentDebt = decimal.Normalize(decimal.Sub(sup.CurrentDebt, pay))
		if err := tx.Model(&sup).Updates(map[string]any{"current_debt": sup.CurrentDebt, "updated_at": now}).Error; err != nil {
			return err
		}
		opType := "out"
		opCat := "supplier_payment"
		opActivity := "operational"
		opDate := now.Format("2006-01-02")
		isAuto := true
		desc := "Оплата долга поставщику"
		if sup.Name != nil && *sup.Name != "" {
			desc = "Оплата долга: " + *sup.Name
		}
		accID := in.AccountID
		ridStr := rid
		// SourceRef = supplier.id — привязка платежа к поставщику по ID, а не по
		// имени: переименование поставщика не теряет историю его платежей.
		supID := sup.ID
		fo := &models.FinancialOperation{
			ID: uuid.NewString(), Type: &opType, Amount: pay, Category: &opCat,
			AccountID: &accID, AccountName: acc.Name, Activity: &opActivity, Date: &opDate,
			Description: &desc, Counterparty: sup.Name, IsAuto: &isAuto,
			SourceRef:    &supID,
			RestaurantID: &ridStr, CreatedAt: now, UpdatedAt: now,
		}
		if err := tx.Create(fo).Error; err != nil {
			return err
		}
		out = &sup
		return nil
	})
	if err != nil {
		return nil, err
	}
	return out, nil
}

// SupplierOpeningDebtInput — body POST /suppliers/{id}/opening-debt.
type SupplierOpeningDebtInput struct {
	Amount string  `json:"amount"`
	Note   *string `json:"note,omitempty"`
	// Date — когда фактически возник долг (для истории/сортировки), YYYY-MM-DD.
	// Пусто → сегодня.
	Date *string `json:"date,omitempty"`
}

// CreateOpeningDebt — долг поставщику без накладной (067): перенос задолженности
// с момента до перехода на эту систему. Пишем НЕ напрямую в
// suppliers.current_debt (Patch это поле игнорирует намеренно, см. коммент там,
// а «Пересчитать долги» стёр бы такую правку при следующем нажатии), а как
// stock_receipts-строку без товарных позиций, помеченную is_opening_debt —
// PayDebt/allocateDebtPayment и RecomputeDebts уже умеют работать с любым
// debt_amount на накладной, откуда бы он ни взялся.
func (s *SuppliersService) CreateOpeningDebt(ctx context.Context, id string, in SupplierOpeningDebtInput) (*models.StockReceipt, error) {
	// То же право, что и на гашение долга (see PayDebt) — обе стороны одной
	// операции («сколько мы должны») должны быть доступны одним и тем же людям.
	if !hasPermFor(ctx, s.r, "suppliers.manage") && !hasPermFor(ctx, s.r, "finance.manage") {
		return nil, apperrors.Wrap("FORBIDDEN", "недостаточно прав для внесения долга поставщику", nil)
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	amount, err := decimal.FromString(in.Amount)
	if err != nil || !decimal.IsPositive(amount) {
		return nil, apperrors.Wrap("VALIDATION", "amount must be > 0", err)
	}
	now := time.Now().UTC()
	date := now.Format("2006-01-02")
	if in.Date != nil && *in.Date != "" {
		date = *in.Date
	}
	note := "Начальный долг — внесён вручную, без накладной"
	if in.Note != nil && strings.TrimSpace(*in.Note) != "" {
		note = strings.TrimSpace(*in.Note)
	}
	paymentType := "credit"
	amt := decimal.Normalize(amount)

	var receipt *models.StockReceipt
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var sup models.Supplier
		if err := tx.Clauses(clause.Locking{Strength: "UPDATE"}).
			Where("restaurant_id = ? AND id = ?", rid, id).First(&sup).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		r := &models.StockReceipt{
			ID:            uuid.NewString(),
			SupplierID:    &id,
			SupplierName:  sup.Name,
			Date:          &date,
			Note:          &note,
			TotalAmount:   amt,
			PaymentType:   &paymentType,
			PaidAmount:    decimal.Zero,
			DebtAmount:    amt,
			IsOpeningDebt: true,
			RestaurantID:  &rid,
			CreatedAt:     now,
			UpdatedAt:     now,
		}
		if err := tx.Create(r).Error; err != nil {
			return err
		}
		sup.CurrentDebt = decimal.Normalize(decimal.Add(sup.CurrentDebt, amt))
		if err := tx.Model(&sup).Updates(map[string]any{"current_debt": sup.CurrentDebt, "updated_at": now}).Error; err != nil {
			return err
		}
		receipt = r
		return nil
	})
	if err != nil {
		return nil, err
	}
	return receipt, nil
}

// ─── Reservations ──────────────────────────────────────────────────────────

type ReservationsService struct{ r *repo.Repo }

func NewReservationsService(r *repo.Repo) *ReservationsService {
	return &ReservationsService{r: r}
}

type ReservationInput struct {
	TableID     *string `json:"table_id,omitempty"`
	GuestName   *string `json:"guest_name,omitempty"`
	GuestPhone  *string `json:"guest_phone,omitempty"`
	GuestsCount *int    `json:"guests_count,omitempty"`
	ReservedAt  *string `json:"reserved_at,omitempty"` // RFC3339
	DurationMin *int    `json:"duration_min,omitempty"`
	Status      *string `json:"status,omitempty"`
	Note        *string `json:"note,omitempty"`
}

type ReservationsFilter struct {
	Status string
	From   *time.Time
	To     *time.Time
}

func (s *ReservationsService) List(ctx context.Context, f ReservationsFilter) ([]models.Reservation, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	q := scoped
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	if f.From != nil {
		q = q.Where("reserved_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("reserved_at < ?", *f.To)
	}
	var rows []models.Reservation
	if err := q.Order("reserved_at ASC").Find(&rows).Error; err != nil {
		return nil, err
	}
	return rows, nil
}

func (s *ReservationsService) Create(ctx context.Context, in ReservationInput) (*models.Reservation, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if in.GuestName == nil || *in.GuestName == "" {
		return nil, apperrors.Wrap("VALIDATION", "guest_name is required", nil)
	}
	now := time.Now().UTC()
	r := &models.Reservation{
		ID:      uuid.NewString(),
		TableID: in.TableID, GuestName: in.GuestName, GuestPhone: in.GuestPhone,
		GuestsCount: in.GuestsCount, DurationMin: in.DurationMin,
		Status: in.Status, Note: in.Note,
		RestaurantID: &rid, CreatedAt: now,
	}
	if in.ReservedAt != nil {
		t, err := timeutil.ParseLooseRFC3339(*in.ReservedAt)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad reserved_at (RFC3339)", err)
		}
		r.ReservedAt = &t
	}
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		scoped, err := tr.ForTenant(ctx)
		if err != nil {
			return err
		}
		if err := scoped.Create(r).Error; err != nil {
			return err
		}
		// Side-effect: помечаем стол как 'reserved', иначе бронь не видна на
		// карте зала (она читает table.status, а не список броней). Только если
		// стол сейчас свободен — занятый/чужой статус не перетираем. Обратный
		// переход (seated→occupied, cancelled→free) уже делает Patch.
		status := "active"
		if r.Status != nil && *r.Status != "" {
			status = *r.Status
		}
		if r.TableID != nil && *r.TableID != "" && status == "active" {
			scopedT, err := tr.ForTenant(ctx)
			if err != nil {
				return err
			}
			if err := scopedT.Model(&models.Table{}).
				Where("id = ? AND status = ?", *r.TableID, "free").
				Updates(map[string]any{"status": "reserved", "updated_at": now}).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return r, nil
}

func (s *ReservationsService) Patch(ctx context.Context, id string, in ReservationInput) (*models.Reservation, error) {
	var out models.Reservation
	err := s.r.Transaction(ctx, func(tr *repo.Repo) error {
		scoped, err := tr.ForTenant(ctx)
		if err != nil {
			return err
		}
		var existing models.Reservation
		if err := scoped.Where("id = ?", id).First(&existing).Error; err != nil {
			if errors.Is(err, gorm.ErrRecordNotFound) {
				return apperrors.ErrNotFound
			}
			return err
		}
		updates := map[string]any{}
		if in.TableID != nil {
			updates["table_id"] = *in.TableID
		}
		if in.GuestName != nil {
			updates["guest_name"] = *in.GuestName
		}
		if in.GuestPhone != nil {
			updates["guest_phone"] = *in.GuestPhone
		}
		if in.GuestsCount != nil {
			updates["guests_count"] = *in.GuestsCount
		}
		if in.DurationMin != nil {
			updates["duration_min"] = *in.DurationMin
		}
		if in.Status != nil {
			updates["status"] = *in.Status
		}
		if in.Note != nil {
			updates["note"] = *in.Note
		}
		if in.ReservedAt != nil {
			t, err := timeutil.ParseLooseRFC3339(*in.ReservedAt)
			if err != nil {
				return apperrors.Wrap("VALIDATION", "bad reserved_at", err)
			}
			updates["reserved_at"] = t
		}
		if len(updates) == 0 {
			out = existing
			return nil
		}
		scoped2, _ := tr.ForTenant(ctx)
		if err := scoped2.Model(&existing).Updates(updates).Error; err != nil {
			return err
		}

		// Side-effect on table status when reservation.status changes.
		// 'seated' → table.status='occupied'. 'completed'/'cancelled' → if table
		// linked to this reservation is in 'reserved' status, free it.
		if in.Status != nil {
			tableID := existing.TableID
			if in.TableID != nil && *in.TableID != "" {
				v := *in.TableID
				tableID = &v
			}
			if tableID != nil && *tableID != "" {
				scopedT, _ := tr.ForTenant(ctx)
				var tbl models.Table
				if err := scopedT.Where("id = ?", *tableID).First(&tbl).Error; err == nil {
					switch *in.Status {
					case "seated":
						scopedU, _ := tr.ForTenant(ctx)
						if err := scopedU.Model(&tbl).Updates(map[string]any{
							"status":     "occupied",
							"updated_at": time.Now().UTC(),
						}).Error; err != nil {
							return err
						}
					case "completed", "cancelled", "no_show":
						// no_show тоже освобождает стол — гость не пришёл, держать
						// бронь на столе незачем (иначе стол залипает в 'reserved').
						if tbl.Status != nil && (*tbl.Status == "reserved" || *tbl.Status == "occupied") {
							scopedU, _ := tr.ForTenant(ctx)
							freeUpd := map[string]any{
								"status":     "free",
								"updated_at": time.Now().UTC(),
							}
							// Clear current_order_id only if it pointed to nothing
							// concrete (no order in flight tied to this reservation).
							if tbl.CurrentOrderID == nil || *tbl.CurrentOrderID == "" {
								freeUpd["current_order_id"] = nil
							}
							if err := scopedU.Model(&tbl).Updates(freeUpd).Error; err != nil {
								return err
							}
						}
					}
				}
			}
		}

		scoped3, _ := tr.ForTenant(ctx)
		if err := scoped3.Where("id = ?", id).First(&out).Error; err != nil {
			return err
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &out, nil
}

// PatchStatusInput — body POST /api/v1/reservations/{id}/status.
type ReservationStatusInput struct {
	Status  *string `json:"status,omitempty"`
	TableID *string `json:"table_id,omitempty"`
}

// PatchStatus — специализированный эндпоинт для смены статуса брони + side-effect
// на стол. Эквивалентен PATCH с {status, table_id?}.
func (s *ReservationsService) PatchStatus(ctx context.Context, id string, in ReservationStatusInput) (*models.Reservation, error) {
	if in.Status == nil || *in.Status == "" {
		return nil, apperrors.Wrap("VALIDATION", "status is required", nil)
	}
	return s.Patch(ctx, id, ReservationInput{Status: in.Status, TableID: in.TableID})
}

func (s *ReservationsService) Delete(ctx context.Context, id string) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	res := scoped.Where("id = ?", id).Delete(&models.Reservation{})
	if res.Error != nil {
		return res.Error
	}
	if res.RowsAffected == 0 {
		return apperrors.ErrNotFound
	}
	return nil
}

// ─── Restaurant settings ───────────────────────────────────────────────────

type RestaurantService struct{ r *repo.Repo }

func NewRestaurantService(r *repo.Repo) *RestaurantService { return &RestaurantService{r: r} }

type RestaurantInput struct {
	Name               *string `json:"name,omitempty"`
	Slug               *string `json:"slug,omitempty"`
	LogoURL            *string `json:"logo_url,omitempty"`
	Address            *string `json:"address,omitempty"`
	Phone              *string `json:"phone,omitempty"`
	Currency           *string `json:"currency,omitempty"`
	ServicePercent     *string `json:"service_percent,omitempty"`
	Timezone           *string `json:"timezone,omitempty"`
	EnforceStockCheck  *bool   `json:"enforce_stock_check,omitempty"`
	TechCardsEnabled   *bool   `json:"tech_cards_enabled,omitempty"`
	AutoReadyMode      *bool   `json:"auto_ready_mode,omitempty"`
	AutoReadyBufferMin *int    `json:"auto_ready_buffer_min,omitempty"`
	PinLockEnabled     *bool   `json:"pin_lock_enabled,omitempty"`
	PinLockTimeoutMin  *int    `json:"pin_lock_timeout_min,omitempty"`
	SupplyAllowNeg     *bool   `json:"supply_allow_negative,omitempty"`
}

// Get — текущий ресторан (из tenant).
func (s *RestaurantService) Get(ctx context.Context) (*models.Restaurant, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var r models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&r).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &r, nil
}

// Patch — обновление настроек текущего ресторана.
func (s *RestaurantService) Patch(ctx context.Context, in RestaurantInput) (*models.Restaurant, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	updates := map[string]any{"updated_at": time.Now().UTC()}
	if in.Name != nil {
		updates["name"] = *in.Name
	}
	if in.Slug != nil {
		updates["slug"] = *in.Slug
	}
	if in.LogoURL != nil {
		updates["logo_url"] = *in.LogoURL
	}
	if in.Address != nil {
		updates["address"] = *in.Address
	}
	if in.Phone != nil {
		updates["phone"] = *in.Phone
	}
	if in.Currency != nil {
		updates["currency"] = *in.Currency
	}
	if in.Timezone != nil {
		updates["timezone"] = *in.Timezone
	}
	if in.ServicePercent != nil {
		d, err := decimal.FromString(*in.ServicePercent)
		if err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad service_percent", err)
		}
		updates["service_percent"] = d
	}
	if in.EnforceStockCheck != nil {
		updates["enforce_stock_check"] = *in.EnforceStockCheck
	}
	if in.TechCardsEnabled != nil {
		updates["tech_cards_enabled"] = *in.TechCardsEnabled
	}
	if in.AutoReadyMode != nil {
		updates["auto_ready_mode"] = *in.AutoReadyMode
	}
	if in.AutoReadyBufferMin != nil {
		updates["auto_ready_buffer_min"] = *in.AutoReadyBufferMin
	}
	if in.PinLockEnabled != nil {
		updates["pin_lock_enabled"] = *in.PinLockEnabled
	}
	if in.PinLockTimeoutMin != nil {
		updates["pin_lock_timeout_min"] = *in.PinLockTimeoutMin
	}
	if in.SupplyAllowNeg != nil {
		updates["supply_allow_negative"] = *in.SupplyAllowNeg
	}

	if err := s.r.Raw().WithContext(ctx).Model(&models.Restaurant{}).
		Where("id = ?", rid).Updates(updates).Error; err != nil {
		return nil, err
	}
	return s.Get(ctx)
}
