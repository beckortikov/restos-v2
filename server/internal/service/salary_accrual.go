package service

import (
	"context"
	"time"

	"github.com/google/uuid"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
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
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	// Дни из табеля (уникальные даты прихода) за месяц.
	dates := map[string]struct{}{}
	var te []struct {
		D string `gorm:"column:d"`
	}
	if err := raw.Table("time_entries").
		Select("DISTINCT clock_in::date::text AS d").
		Where("restaurant_id = ? AND user_id::text = ? AND clock_in IS NOT NULL", rid, userID).
		Where("to_char(clock_in, 'YYYY-MM') = ?", period).
		Scan(&te).Error; err != nil {
		return 0, err
	}
	for _, x := range te {
		dates[x.D] = struct{}{}
	}
	// + ручные отметки (059) за месяц.
	var md []struct {
		D string `gorm:"column:d"`
	}
	if err := raw.Table("salary_worked_days").
		Select("work_date::text AS d").
		Where("restaurant_id = ? AND user_id::text = ?", rid, userID).
		Where("to_char(work_date, 'YYYY-MM') = ?", period).
		Scan(&md).Error; err != nil {
		return 0, err
	}
	for _, x := range md {
		dates[x.D] = struct{}{}
	}
	return len(dates), nil
}

// daysWorked — сколько РАЗНЫХ дней сотрудник отмечен в табеле за период.
//
// Считаем по дате прихода (clock_in), а не по числу записей: две отметки в
// один день — это один рабочий день, иначе сотрудник, отметившийся после
// перерыва, получил бы двойную оплату. Дата приводится к дате без времени.
func (s *SalaryService) daysWorked(ctx context.Context, restaurantID, from, to string) (map[string]int, error) {
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	// (user, date) из табеля и из ручных отметок → union в Go, чтобы один и тот
	// же день из двух источников не задваивался.
	type ud struct {
		UserID string `gorm:"column:user_id"`
		D      string `gorm:"column:d"`
	}
	q1 := raw.Table("time_entries").
		Select("DISTINCT user_id::text AS user_id, clock_in::date::text AS d").
		Where("restaurant_id = ? AND user_id IS NOT NULL AND clock_in IS NOT NULL", restaurantID)
	if from != "" {
		q1 = q1.Where("clock_in::date >= ?::date", from)
	}
	if to != "" {
		q1 = q1.Where("clock_in::date <= ?::date", to)
	}
	var r1 []ud
	if err := q1.Scan(&r1).Error; err != nil {
		return nil, err
	}
	q2 := raw.Table("salary_worked_days").
		Select("user_id::text AS user_id, work_date::text AS d").
		Where("restaurant_id = ?", restaurantID)
	if from != "" {
		q2 = q2.Where("work_date >= ?::date", from)
	}
	if to != "" {
		q2 = q2.Where("work_date <= ?::date", to)
	}
	var r2 []ud
	if err := q2.Scan(&r2).Error; err != nil {
		return nil, err
	}
	sets := map[string]map[string]struct{}{}
	addRows := func(rows []ud) {
		for _, x := range rows {
			if sets[x.UserID] == nil {
				sets[x.UserID] = map[string]struct{}{}
			}
			sets[x.UserID][x.D] = struct{}{}
		}
	}
	addRows(r1)
	addRows(r2)
	out := make(map[string]int, len(sets))
	for u, d := range sets {
		out[u] = len(d)
	}
	return out, nil
}

// ─── Ручная отметка отработанных дней (059) ─────────────────────────────────

// WorkedDaysResult — дни для календаря отметки: из табеля (снять нельзя, это
// реальный приход) и ручные (059, toggleable). Count — уникальных дней всего.
type WorkedDaysResult struct {
	ShiftDates  []string `json:"shift_dates"`
	ManualDates []string `json:"manual_dates"`
	Count       int      `json:"count"`
}

// WorkedDays — отработанные дни сотрудника за [from, to] (YYYY-MM-DD включ.).
func (s *SalaryService) WorkedDays(ctx context.Context, userID, from, to string) (*WorkedDaysResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if userID == "" {
		return nil, apperrors.Wrap("VALIDATION", "user_id is required", nil)
	}
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	out := &WorkedDaysResult{ShiftDates: []string{}, ManualDates: []string{}}
	union := map[string]struct{}{}

	var te []struct {
		D string `gorm:"column:d"`
	}
	q1 := raw.Table("time_entries").
		Select("DISTINCT clock_in::date::text AS d").
		Where("restaurant_id = ? AND user_id::text = ? AND clock_in IS NOT NULL", rid, userID)
	if from != "" {
		q1 = q1.Where("clock_in::date >= ?::date", from)
	}
	if to != "" {
		q1 = q1.Where("clock_in::date <= ?::date", to)
	}
	if err := q1.Order("d").Scan(&te).Error; err != nil {
		return nil, err
	}
	for _, x := range te {
		out.ShiftDates = append(out.ShiftDates, x.D)
		union[x.D] = struct{}{}
	}

	var md []struct {
		D string `gorm:"column:d"`
	}
	q2 := raw.Table("salary_worked_days").
		Select("work_date::text AS d").
		Where("restaurant_id = ? AND user_id::text = ?", rid, userID)
	if from != "" {
		q2 = q2.Where("work_date >= ?::date", from)
	}
	if to != "" {
		q2 = q2.Where("work_date <= ?::date", to)
	}
	if err := q2.Order("work_date").Scan(&md).Error; err != nil {
		return nil, err
	}
	for _, x := range md {
		out.ManualDates = append(out.ManualDates, x.D)
		union[x.D] = struct{}{}
	}
	out.Count = len(union)
	return out, nil
}

// SetWorkedDays — заменяет РУЧНЫЕ отметки сотрудника в [from, to] на набор dates.
// Табель (реальные приходы) не трогает — только salary_worked_days. Идемпотентно:
// повторный вызов с тем же набором ничего не меняет. Календарь шлёт полный набор
// отмеченных дат месяца — так и точечный тык, и «N дней подряд» — один вызов.
func (s *SalaryService) SetWorkedDays(ctx context.Context, userID, from, to string, dates []string) (*WorkedDaysResult, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if userID == "" {
		return nil, apperrors.Wrap("VALIDATION", "user_id is required", nil)
	}
	if from == "" || to == "" {
		return nil, apperrors.Wrap("VALIDATION", "from/to are required", nil)
	}
	// Валидация + дедуп дат: формат YYYY-MM-DD и в пределах [from, to].
	seen := map[string]struct{}{}
	clean := make([]string, 0, len(dates))
	for _, d := range dates {
		if _, err := time.Parse("2006-01-02", d); err != nil {
			return nil, apperrors.Wrap("VALIDATION", "bad date: "+d, nil)
		}
		if d < from || d > to {
			return nil, apperrors.Wrap("VALIDATION", "date "+d+" вне периода", nil)
		}
		if _, ok := seen[d]; ok {
			continue
		}
		seen[d] = struct{}{}
		clean = append(clean, d)
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		// Снимаем прежние ручные отметки в периоде, ставим новый набор.
		if err := tx.Where("restaurant_id = ? AND user_id::text = ? AND work_date >= ?::date AND work_date <= ?::date",
			rid, userID, from, to).Delete(&models.SalaryWorkedDay{}).Error; err != nil {
			return err
		}
		now := time.Now().UTC()
		uid := userID
		ridStr := rid
		for _, d := range clean {
			row := &models.SalaryWorkedDay{
				ID: uuid.NewString(), RestaurantID: &ridStr, UserID: &uid, WorkDate: d, CreatedAt: now,
			}
			if err := tx.Create(row).Error; err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.WorkedDays(ctx, userID, from, to)
}
