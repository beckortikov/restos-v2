package service

import (
	"context"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// Типы оплаты труда (054).
const (
	PayTypeMonthly = "monthly"
	PayTypeDaily   = "daily"
)

// SalaryAccrualRow — сколько сотруднику НАЧИСЛЕНО за период и из чего это
// сложилось.
//
// Для оклада (monthly) начисление не зависит от периода — это фиксированная
// сумма из карточки. Для дневной оплаты (daily) считается ставка × число
// отработанных дней, где день берётся из табеля: считается день, в котором
// есть хотя бы одна отметка прихода. Именно поэтому DaysWorked отдаётся
// наружу — без него сумма выглядит как необъяснимое число, и менеджер не
// может проверить расчёт.
type SalaryAccrualRow struct {
	UserID     string          `json:"user_id"`
	UserName   string          `json:"user_name"`
	Position   string          `json:"position"`
	Role       string          `json:"role"`
	PayType    string          `json:"pay_type"`
	Salary     decimal.Decimal `json:"salary"`
	DailyRate  decimal.Decimal `json:"daily_rate"`
	DaysWorked int             `json:"days_worked"`
	Accrued    decimal.Decimal `json:"accrued"`
	Advance    decimal.Decimal `json:"advance"`
	Deductions decimal.Decimal `json:"deductions"`
}

// SalaryAccrual — начисления по всем сотрудникам за период [from, to].
// from/to — YYYY-MM-DD включительно.
func (s *SalaryService) SalaryAccrual(ctx context.Context, from, to string) ([]SalaryAccrualRow, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var users []models.User
	if err := scoped.Where("role NOT IN ?", []string{"owner", "superadmin"}).
		Order("name ASC").Find(&users).Error; err != nil {
		return nil, err
	}
	if len(users) == 0 {
		return []SalaryAccrualRow{}, nil
	}

	days, err := s.daysWorked(ctx, rid, from, to)
	if err != nil {
		return nil, err
	}

	out := make([]SalaryAccrualRow, 0, len(users))
	for _, u := range users {
		row := SalaryAccrualRow{
			UserID:     u.ID,
			PayType:    payTypeOf(u),
			Salary:     decimal.Normalize(u.Salary),
			DailyRate:  decimal.Normalize(u.DailyRate),
			DaysWorked: days[u.ID],
			Advance:    decimal.Normalize(u.Advance),
			Deductions: decimal.Normalize(u.Deductions),
		}
		if u.Name != nil {
			row.UserName = *u.Name
		}
		if u.Position != nil {
			row.Position = *u.Position
		}
		if u.Role != nil {
			row.Role = *u.Role
		}
		row.Accrued = accruedFor(u, row.DaysWorked)
		out = append(out, row)
	}
	return out, nil
}

// payTypeOf — с дефолтом. NULL/пусто трактуем как оклад: это поведение до 053,
// и молча перевести кого-то на дневную оплату нельзя.
func payTypeOf(u models.User) string {
	if u.PayType != nil && *u.PayType == PayTypeDaily {
		return PayTypeDaily
	}
	return PayTypeMonthly
}

// accruedFor — начислено за период.
func accruedFor(u models.User, daysWorked int) decimal.Decimal {
	if payTypeOf(u) == PayTypeDaily {
		return decimal.Normalize(decimal.Mul(u.DailyRate, decimal.FromInt(int64(daysWorked))))
	}
	return decimal.Normalize(u.Salary)
}

// daysWorkedInPeriod — отработанные дни ОДНОГО сотрудника за месяц period
// («YYYY-MM»). Используется капом на выплату: там период приходит месяцем, а
// не парой дат.
func (s *SalaryService) daysWorkedInPeriod(ctx context.Context, userID, period string) (int, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return 0, err
	}
	// «2026-07» → [2026-07-01, 2026-07-31]. Верхнюю границу не вычисляем
	// вручную: сравнение идёт по префиксу месяца.
	type row struct {
		Cnt int `gorm:"column:cnt"`
	}
	var r row
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	if err := raw.Table("time_entries").
		Select("COUNT(DISTINCT clock_in::date) AS cnt").
		Where("restaurant_id = ? AND user_id::text = ? AND clock_in IS NOT NULL", rid, userID).
		Where("to_char(clock_in, 'YYYY-MM') = ?", period).
		Scan(&r).Error; err != nil {
		return 0, err
	}
	return r.Cnt, nil
}

// daysWorked — сколько РАЗНЫХ дней сотрудник отмечен в табеле за период.
//
// Считаем по дате прихода (clock_in), а не по числу записей: две отметки в
// один день — это один рабочий день, иначе сотрудник, отметившийся после
// перерыва, получил бы двойную оплату. Дата приводится к дате без времени.
func (s *SalaryService) daysWorked(ctx context.Context, restaurantID, from, to string) (map[string]int, error) {
	type row struct {
		UserID string `gorm:"column:user_id"`
		Cnt    int    `gorm:"column:cnt"`
	}
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	q := raw.Table("time_entries").
		Select("user_id::text AS user_id, COUNT(DISTINCT clock_in::date) AS cnt").
		Where("restaurant_id = ? AND user_id IS NOT NULL AND clock_in IS NOT NULL", restaurantID)
	if from != "" {
		q = q.Where("clock_in::date >= ?::date", from)
	}
	if to != "" {
		q = q.Where("clock_in::date <= ?::date", to)
	}
	var rows []row
	if err := q.Group("user_id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]int, len(rows))
	for _, r := range rows {
		out[r.UserID] = r.Cnt
	}
	return out, nil
}
