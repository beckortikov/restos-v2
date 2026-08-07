package service

import (
	"context"
	"errors"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

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
// «оплачиваемых единиц» (PaidUnits), где день берётся из табеля: считается
// день, в котором есть хотя бы одна отметка прихода. DaysWorked — сколько
// РАЗНЫХ календарных дней отработано; PaidUnits — то же самое, но день с
// ручным множителем ×2 (066, «две смены в один день») считается дважды.
// В обычном случае (без множителей) PaidUnits == DaysWorked. Оба поля
// отдаются наружу — без них сумма выглядит как необъяснимое число, и
// менеджер не может проверить расчёт.
type SalaryAccrualRow struct {
	UserID     string          `json:"user_id"`
	UserName   string          `json:"user_name"`
	Position   string          `json:"position"`
	Role       string          `json:"role"`
	PayType    string          `json:"pay_type"`
	Salary     decimal.Decimal `json:"salary"`
	DailyRate  decimal.Decimal `json:"daily_rate"`
	DaysWorked int             `json:"days_worked"`
	PaidUnits  int             `json:"paid_units"`
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

	days, units, err := s.daysWorked(ctx, rid, from, to)
	if err != nil {
		return nil, err
	}
	// Аванс/удержания за период — из period-tagged строк salary_advances/
	// salary_deductions, а НЕ из глобальных счётчиков users.advance/deductions:
	// счётчик period-agnostic, поэтому аванс за прошлый месяц раньше срезал
	// остаток текущего (баг владельца).
	advByUser, dedByUser, err := s.advDedByUser(ctx, from, to)
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
			PaidUnits:  units[u.ID],
			Advance:    advByUser[u.ID],
			Deductions: dedByUser[u.ID],
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
		row.Accrued = accruedFor(u, row.PaidUnits)
		out = append(out, row)
	}
	return out, nil
}

// advDedByUser — Σ НЕотменённых авансов и удержаний по всем сотрудникам за
// месяцы, попадающие в диапазон [from, to] (YYYY-MM-DD). Период у строк — тег
// YYYY-MM; сравниваем с месяцами границ лексикографически (для YYYY-MM это
// хронологично). Обычный случай — период = один месяц → один месяц-тег.
func (s *SalaryService) advDedByUser(ctx context.Context, from, to string) (adv, ded map[string]decimal.Decimal, err error) {
	fromM, toM := monthPrefix(from), monthPrefix(to)
	adv = map[string]decimal.Decimal{}
	ded = map[string]decimal.Decimal{}
	type sumRow struct {
		UserID string          `gorm:"column:user_id"`
		Total  decimal.Decimal `gorm:"column:total"`
	}
	sa, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, nil, err
	}
	var arows []sumRow
	if err = sa.Table("salary_advances").
		Select("user_id::text AS user_id, COALESCE(SUM(amount), 0) AS total").
		Where("period >= ? AND period <= ? AND cancelled_at IS NULL", fromM, toM).
		Group("user_id").Scan(&arows).Error; err != nil {
		return nil, nil, err
	}
	for _, r := range arows {
		adv[r.UserID] = decimal.Normalize(r.Total)
	}
	sd, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, nil, err
	}
	var drows []sumRow
	if err = sd.Table("salary_deductions").
		Select("user_id::text AS user_id, COALESCE(SUM(amount), 0) AS total").
		Where("period >= ? AND period <= ? AND cancelled_at IS NULL", fromM, toM).
		Group("user_id").Scan(&drows).Error; err != nil {
		return nil, nil, err
	}
	for _, r := range drows {
		ded[r.UserID] = decimal.Normalize(r.Total)
	}
	return adv, ded, nil
}

// monthPrefix — YYYY-MM-DD → YYYY-MM (для сравнения с тегом period).
func monthPrefix(ymd string) string {
	if len(ymd) >= 7 {
		return ymd[:7]
	}
	return ymd
}

// payTypeOf — с дефолтом. NULL/пусто трактуем как оклад: это поведение до 053,
// и молча перевести кого-то на дневную оплату нельзя.
func payTypeOf(u models.User) string {
	if u.PayType != nil && *u.PayType == PayTypeDaily {
		return PayTypeDaily
	}
	return PayTypeMonthly
}

// accruedFor — начислено за период. paidUnits — не «дни», а оплачиваемые
// единицы: обычный день = 1, день с множителем ×2 (066) = 2. См. daysWorked.
func accruedFor(u models.User, paidUnits int) decimal.Decimal {
	if payTypeOf(u) == PayTypeDaily {
		return decimal.Normalize(decimal.Mul(u.DailyRate, decimal.FromInt(int64(paidUnits))))
	}
	return decimal.Normalize(u.Salary)
}

// dayMultipliers — ручные множители (066) одного сотрудника за период, в
// виде map[work_date]multiplier. Строк нет для дней без override (там
// множитель подразумевается = 1) — таблица хранит только исключения.
func (s *SalaryService) dayMultipliers(ctx context.Context, restaurantID, userID, from, to string) (map[string]int, error) {
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	q := raw.Table("salary_day_multipliers").
		Select("work_date::text AS d, multiplier").
		Where("restaurant_id = ? AND user_id::text = ?", restaurantID, userID)
	if from != "" {
		q = q.Where("work_date >= ?::date", from)
	}
	if to != "" {
		q = q.Where("work_date <= ?::date", to)
	}
	var rows []struct {
		D          string `gorm:"column:d"`
		Multiplier int    `gorm:"column:multiplier"`
	}
	if err := q.Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]int, len(rows))
	for _, r := range rows {
		out[r.D] = r.Multiplier
	}
	return out, nil
}

// daysWorkedInPeriod — отработанные дни и оплачиваемые единицы ОДНОГО
// сотрудника за месяц period («YYYY-MM»). Используется капом на выплату: там
// период приходит месяцем, а не парой дат. paidUnits учитывает множители
// (066): день с ×2 добавляет 2 единицы вместо 1.
func (s *SalaryService) daysWorkedInPeriod(ctx context.Context, userID, period string) (daysWorked, paidUnits int, err error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return 0, 0, err
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
		return 0, 0, err
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
		return 0, 0, err
	}
	for _, x := range md {
		dates[x.D] = struct{}{}
	}
	monthFrom, monthTo := period+"-01", period+"-31"
	mult, err := s.dayMultipliers(ctx, rid, userID, monthFrom, monthTo)
	if err != nil {
		return 0, 0, err
	}
	units := 0
	for d := range dates {
		if m, ok := mult[d]; ok {
			units += m
		} else {
			units++
		}
	}
	return len(dates), units, nil
}

// daysWorked — сколько РАЗНЫХ дней сотрудник отмечен в табеле за период
// (daysWorked), и сколько из этого ОПЛАЧИВАЕМЫХ единиц (paidUnits) с учётом
// ручных множителей (066, «две смены в один день»).
//
// Дни считаем по дате прихода (clock_in), а не по числу записей: две отметки
// в один день — это один рабочий день, иначе сотрудник, отметившийся после
// перерыва, получил бы двойную оплату. Явный множитель ×2 на конкретный день
// (проставляется вручную через календарь) — единственный способ учесть
// реальную вторую смену, не полагаясь на ненадёжную эвристику по интервалу
// между отметками. Без override paidUnits[u] == daysWorked[u].
func (s *SalaryService) daysWorked(ctx context.Context, restaurantID, from, to string) (daysWorked, paidUnits map[string]int, err error) {
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
		return nil, nil, err
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
		return nil, nil, err
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

	// Множители (066) за период, по ВСЕМ сотрудникам сразу — один запрос.
	q3 := raw.Table("salary_day_multipliers").
		Select("user_id::text AS user_id, work_date::text AS d, multiplier").
		Where("restaurant_id = ?", restaurantID)
	if from != "" {
		q3 = q3.Where("work_date >= ?::date", from)
	}
	if to != "" {
		q3 = q3.Where("work_date <= ?::date", to)
	}
	var r3 []struct {
		UserID     string `gorm:"column:user_id"`
		D          string `gorm:"column:d"`
		Multiplier int    `gorm:"column:multiplier"`
	}
	if err := q3.Scan(&r3).Error; err != nil {
		return nil, nil, err
	}
	mult := map[string]map[string]int{}
	for _, x := range r3 {
		if mult[x.UserID] == nil {
			mult[x.UserID] = map[string]int{}
		}
		mult[x.UserID][x.D] = x.Multiplier
	}

	daysWorked = make(map[string]int, len(sets))
	paidUnits = make(map[string]int, len(sets))
	for u, d := range sets {
		daysWorked[u] = len(d)
		units := 0
		for date := range d {
			if m, ok := mult[u][date]; ok {
				units += m
			} else {
				units++
			}
		}
		paidUnits[u] = units
	}
	return daysWorked, paidUnits, nil
}

// ─── Ручная отметка отработанных дней (059) ─────────────────────────────────

// WorkedDaysResult — дни для календаря отметки: из табеля (снять нельзя, это
// реальный приход) и ручные (059, toggleable). Count — уникальных дней всего;
// PaidUnits — то же самое, но дни с множителем (066) считаются кратно.
// Multipliers — только исключения (день без override в карте отсутствует,
// подразумевается ×1).
type WorkedDaysResult struct {
	ShiftDates  []string       `json:"shift_dates"`
	ManualDates []string       `json:"manual_dates"`
	Count       int            `json:"count"`
	PaidUnits   int            `json:"paid_units"`
	Multipliers map[string]int `json:"multipliers"`
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
	out := &WorkedDaysResult{ShiftDates: []string{}, ManualDates: []string{}, Multipliers: map[string]int{}}
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

	mult, err := s.dayMultipliers(ctx, rid, userID, from, to)
	if err != nil {
		return nil, err
	}
	// Multipliers — ВСЕ найденные в периоде, не только для дат из union. Тап
	// «включить день» отмечает дату только локально на клиенте — она попадает
	// в salary_worked_days лишь по кнопке «Сохранить дни» (SetWorkedDays).
	// Если тут же тапнуть «×2», ToggleDayMultiplier создаёт строку корректно,
	// но union (посчитанный из БД) её ещё не видит — старый фильтр «только для
	// дат из union» прятал только что созданный множитель из ответа, и бейдж
	// ×2 не появлялся, пока день не сохранён. PaidUnits — реальный предпросмотр
	// начисления, его по union считаем как раньше (не завышаем на несохранённые дни).
	out.Multipliers = mult
	units := 0
	for d := range union {
		if m, ok := mult[d]; ok {
			units += m
		} else {
			units++
		}
	}
	out.PaidUnits = units
	return out, nil
}

// ToggleDayMultiplier — переключает день сотрудника между ×1 (обычный,
// строки в таблице нет) и ×2 («две смены в один день», 066). Возвращает
// свежий WorkedDays(from, to), чтобы клиент одним ответом обновил и бейджи, и
// итоговую сумму — тыком по дню в календаре, без отдельного перезапроса.
func (s *SalaryService) ToggleDayMultiplier(ctx context.Context, userID, date, from, to string) (*WorkedDaysResult, error) {
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
	if _, err := time.Parse("2006-01-02", date); err != nil {
		return nil, apperrors.Wrap("VALIDATION", "bad date: "+date, nil)
	}

	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var existing models.SalaryDayMultiplier
		err := tx.Where("restaurant_id = ? AND user_id::text = ? AND work_date = ?::date", rid, userID, date).
			Take(&existing).Error
		if err == nil {
			return tx.Delete(&existing).Error
		}
		if !errors.Is(err, gorm.ErrRecordNotFound) {
			return err
		}
		uid, ridStr := userID, rid
		return tx.Create(&models.SalaryDayMultiplier{
			ID: uuid.NewString(), RestaurantID: &ridStr, UserID: &uid, WorkDate: date,
			Multiplier: 2, CreatedAt: time.Now().UTC(),
		}).Error
	})
	if err != nil {
		return nil, err
	}
	return s.WorkedDays(ctx, userID, from, to)
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
