package service

// Утверждение табеля за период (106).
//
// Начисление считается на лету из отметок, и правка задним числом молча меняет
// уже показанную цифру. Пока период не выплачен — это удобно. После выплаты —
// источник спора: в ведомости одна сумма, на экране другая.
//
// Утверждение фиксирует итог на момент нажатия. Дальше видно расхождение —
// «утверждено 41,5 ч, сейчас 43,0 ч», — и человек решает, пересогласовать или
// оставить. Само расхождение НЕ блокируется: запретить правку задним числом
// значило бы, что забытый уход исправить нельзя вовсе.

import (
	"context"
	"strconv"
	"time"

	"github.com/google/uuid"
	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ApprovalRow — строка сводки «утверждено против того, что сейчас».
type ApprovalRow struct {
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
	// Approved* — снимок на момент утверждения.
	ApprovedDays    int             `json:"approved_days"`
	ApprovedHours   decimal.Decimal `json:"approved_hours"`
	ApprovedAccrued decimal.Decimal `json:"approved_accrued"`
	// Current* — то же, посчитанное сейчас.
	CurrentDays    int             `json:"current_days"`
	CurrentHours   decimal.Decimal `json:"current_hours"`
	CurrentAccrued decimal.Decimal `json:"current_accrued"`
	// Changed — расхождение есть. Считается сервером, а не клиентом: сравнение
	// денег по строкам в JS — прямая дорога к «0.1 + 0.2».
	Changed bool `json:"changed"`
}

// ApprovalStatus — состояние периода.
type ApprovalStatus struct {
	From string `json:"from"`
	To   string `json:"to"`
	// Approved — период утверждён (есть непогашенный снимок).
	Approved       bool       `json:"approved"`
	ApprovedAt     *time.Time `json:"approved_at,omitempty"`
	ApprovedByName string     `json:"approved_by_name,omitempty"`
	// ChangedCount — у скольких сотрудников данные разошлись со снимком.
	ChangedCount int             `json:"changed_count"`
	TotalAccrued decimal.Decimal `json:"total_accrued"`
	Rows         []ApprovalRow   `json:"rows"`
}

// TimesheetApprovalService — снимки табеля.
type TimesheetApprovalService struct {
	r      *repo.Repo
	salary *SalaryService
}

func NewTimesheetApprovalService(r *repo.Repo, salary *SalaryService) *TimesheetApprovalService {
	return &TimesheetApprovalService{r: r, salary: salary}
}

// Status — что утверждено за период и что с тех пор изменилось.
func (s *TimesheetApprovalService) Status(ctx context.Context, from, to string) (*ApprovalStatus, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	f, t, err := normalizePeriod(from, to)
	if err != nil {
		return nil, err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}

	var saved []models.TimesheetApproval
	if err := scoped.
		Where("period_from = ?::date AND period_to = ?::date AND cancelled_at IS NULL", f, t).
		Find(&saved).Error; err != nil {
		return nil, err
	}

	current, err := s.salary.SalaryAccrual(ctx, f, t)
	if err != nil {
		return nil, err
	}
	hours, err := s.hoursByUser(ctx, f, t)
	if err != nil {
		return nil, err
	}

	byUser := make(map[string]models.TimesheetApproval, len(saved))
	for _, a := range saved {
		byUser[a.UserID] = a
	}

	st := &ApprovalStatus{From: f, To: t, Approved: len(saved) > 0, TotalAccrued: decimal.FromInt(0)}
	if len(saved) > 0 {
		st.ApprovedAt = &saved[0].ApprovedAt
		if saved[0].ApprovedByName != nil {
			st.ApprovedByName = *saved[0].ApprovedByName
		}
	}

	for i := range current {
		row := ApprovalRow{
			UserID:         current[i].UserID,
			UserName:       current[i].UserName,
			CurrentDays:    current[i].DaysWorked,
			CurrentHours:   hours[current[i].UserID],
			CurrentAccrued: current[i].Accrued,
		}
		if a, ok := byUser[current[i].UserID]; ok {
			row.ApprovedDays, row.ApprovedHours, row.ApprovedAccrued = a.Days, a.Hours, a.Accrued
			row.Changed = a.Days != row.CurrentDays ||
				!a.Hours.Equal(row.CurrentHours) ||
				!a.Accrued.Equal(row.CurrentAccrued)
			st.TotalAccrued = decimal.Add(st.TotalAccrued, a.Accrued)
		} else if st.Approved && (row.CurrentDays > 0 || decimal.IsPositive(row.CurrentAccrued)) {
			// Сотрудник появился уже ПОСЛЕ утверждения — это тоже расхождение:
			// в утверждённой ведомости его нет, а часы у него есть.
			//
			// Пустых (0 дней, 0 сумма) это не касается: их и не фиксировали,
			// иначе каждый не работавший в периоде числился бы «изменившимся»
			// и прятал настоящие расхождения.
			row.Changed = true
		}
		if row.Changed {
			st.ChangedCount++
		}
		st.Rows = append(st.Rows, row)
	}
	st.TotalAccrued = decimal.Normalize(st.TotalAccrued)
	return st, nil
}

// Approve — зафиксировать период. Повторное утверждение уже утверждённого
// периода отклоняем: чтобы пересогласовать, его сначала переоткрывают — так в
// истории остаётся след, что суммы менялись.
func (s *TimesheetApprovalService) Approve(ctx context.Context, from, to string) (*ApprovalStatus, error) {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return nil, err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	f, t, err := normalizePeriod(from, to)
	if err != nil {
		return nil, err
	}

	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var existing int64
	if err := scoped.Model(&models.TimesheetApproval{}).
		Where("period_from = ?::date AND period_to = ?::date AND cancelled_at IS NULL", f, t).
		Count(&existing).Error; err != nil {
		return nil, err
	}
	if existing > 0 {
		return nil, apperrors.Wrap("CONFLICT", "период уже утверждён — сначала переоткройте его", nil)
	}

	rows, err := s.salary.SalaryAccrual(ctx, f, t)
	if err != nil {
		return nil, err
	}
	hours, err := s.hoursByUser(ctx, f, t)
	if err != nil {
		return nil, err
	}

	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		for i := range rows {
			// Сотрудников без единого дня и без начисления не фиксируем: строки
			// «0 ч, 0 сомони» только зашумили бы сверку расхождений.
			if rows[i].DaysWorked == 0 && !decimal.IsPositive(rows[i].Accrued) {
				continue
			}
			row := models.TimesheetApproval{
				ID: uuid.NewString(), RestaurantID: &rid,
				PeriodFrom: f, PeriodTo: t, UserID: rows[i].UserID,
				Days: rows[i].DaysWorked, Hours: hours[rows[i].UserID], Accrued: rows[i].Accrued,
				ApprovedAt: now, CreatedAt: now, UpdatedAt: now,
			}
			if actor.UserID != "" {
				row.ApprovedBy = &actor.UserID
			}
			if actor.UserName != "" {
				name := actor.UserName
				row.ApprovedByName = &name
			}
			if err := tx.Create(&row).Error; err != nil {
				return err
			}
			if err := recordTimesheetApprovalSync(tx, row.ID); err != nil {
				return err
			}
		}
		return nil
	})
	if err != nil {
		return nil, err
	}
	return s.Status(ctx, f, t)
}

// Cancel — переоткрыть период. Строки не удаляем, а помечаем: кто и когда снял
// утверждение, в споре важнее самого факта снятия.
func (s *TimesheetApprovalService) Cancel(ctx context.Context, from, to string) error {
	if err := requirePermFor(ctx, s.r, "payroll.manage"); err != nil {
		return err
	}
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	f, t, err := normalizePeriod(from, to)
	if err != nil {
		return err
	}
	actor, _ := audit.ActorFromContext(ctx)
	now := time.Now().UTC()

	return s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		var rows []models.TimesheetApproval
		if err := tx.Where("restaurant_id = ? AND period_from = ?::date AND period_to = ?::date AND cancelled_at IS NULL",
			rid, f, t).Find(&rows).Error; err != nil {
			return err
		}
		if len(rows) == 0 {
			return apperrors.ErrNotFound
		}
		updates := map[string]any{"cancelled_at": now, "updated_at": now}
		if actor.UserID != "" {
			updates["cancelled_by"] = actor.UserID
		}
		for i := range rows {
			if err := tx.Model(&models.TimesheetApproval{}).
				Where("id = ?", rows[i].ID).Updates(updates).Error; err != nil {
				return err
			}
			if err := recordTimesheetApprovalSync(tx, rows[i].ID); err != nil {
				return err
			}
		}
		return nil
	})
}

// hoursByUser — отработанные часы за период по закрытым сменам.
func (s *TimesheetApprovalService) hoursByUser(ctx context.Context, from, to string) (map[string]decimal.Decimal, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	type row struct {
		UserID string  `gorm:"column:user_id"`
		Hours  float64 `gorm:"column:hours"`
	}
	var rows []row
	if err := s.r.Raw().WithContext(ctx).Table("time_entries").
		Select("user_id::text AS user_id, COALESCE(SUM(total_hours), 0)::float8 AS hours").
		Where(`restaurant_id = ? AND user_id IS NOT NULL AND clock_out IS NOT NULL
		       AND clock_in::date >= ?::date AND clock_in::date <= ?::date`, rid, from, to).
		Group("user_id").Scan(&rows).Error; err != nil {
		return nil, err
	}
	out := make(map[string]decimal.Decimal, len(rows))
	for _, r := range rows {
		out[r.UserID] = decimal.MustFromString(trimFloat(r.Hours))
	}
	return out, nil
}

func normalizePeriod(from, to string) (string, string, error) {
	f, err := normalizeDate(from)
	if err != nil {
		return "", "", err
	}
	t, err := normalizeDate(to)
	if err != nil {
		return "", "", err
	}
	if t < f {
		return "", "", apperrors.Wrap("VALIDATION", "конец периода раньше начала", nil)
	}
	return f, t, nil
}

// trimFloat — часы приходят из SUM как float; в decimal переводим ЧЕРЕЗ
// СТРОКУ с двумя знаками, а не напрямую: иначе в сумму часов протекает
// двоичная дробь, и сравнение «утверждено против сейчас» начинает врать на
// ровном месте.
func trimFloat(v float64) string {
	return strconv.FormatFloat(v, 'f', 2, 64)
}
