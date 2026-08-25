package service

import (
	"context"
	"strings"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// SalaryReport — «кому сколько выдали и когда» за период.
//
// Источник — financial_operations: только там есть дата, сумма, счёт и
// сотрудник (source_ref = user_id). Счётчики users.advance/deductions для
// отчёта не годятся: они «текущие», без истории и без дат.
//
// Категории проводок:
//   - «Зарплата» — окончательный расчёт;
//   - «Аванс»    — аванс (отдельная категория с этой версии);
//   - «Сервис»   — выплата сервис-чарджа официанту.
//
// Легаси: до разделения категорий авансы писались как «Зарплата» с суффиксом
// «(аванс)» в counterparty. Отчёт разбирает и такие строки — иначе история
// до обновления схлопнулась бы в зарплату и завысила её.
type SalaryReport struct {
	From    string             `json:"from"`
	To      string             `json:"to"`
	Rows    []SalaryReportRow  `json:"rows"`
	Payouts []SalaryPayoutRow  `json:"payouts"`
	Totals  SalaryReportTotals `json:"totals"`
}

// SalaryReportRow — сводка по одному сотруднику за период.
type SalaryReportRow struct {
	UserID   string `json:"user_id"`
	UserName string `json:"user_name"`
	Position string `json:"position"`
	Role     string `json:"role"`
	// Salary — текущий оклад из карточки, справочно (не за период).
	Salary       decimal.Decimal `json:"salary"`
	SalaryPaid   decimal.Decimal `json:"salary_paid"`
	AdvancePaid  decimal.Decimal `json:"advance_paid"`
	ServicePaid  decimal.Decimal `json:"service_paid"`
	Total        decimal.Decimal `json:"total"`
	PayoutsCount int             `json:"payouts_count"`
	LastPayoutAt string          `json:"last_payout_at,omitempty"`
}

// SalaryPayoutRow — одна выплата: когда, кому, сколько, с какого счёта.
type SalaryPayoutRow struct {
	ID          string          `json:"id"`
	Date        string          `json:"date"`
	UserID      string          `json:"user_id"`
	UserName    string          `json:"user_name"`
	Kind        string          `json:"kind"` // salary | advance | service
	Amount      decimal.Decimal `json:"amount"`
	AccountID   string          `json:"account_id,omitempty"`
	AccountName string          `json:"account_name,omitempty"`
	// PaidByName — имя узла сети, который фактически заплатил (Ф-Р/Ф-С5):
	// у зеркала филиала AccountName пуст (своего счёта не было, см.
	// sync_ingest.go «Зеркала расходов»), а это поле резолвит paid_by_restaurant_id
	// в человекочитаемое имя, чтобы лента не выглядела как «выплата в никуда».
	PaidByName  string `json:"paid_by_name,omitempty"`
	Description string `json:"description,omitempty"`
	// IsOverride — выплата выше расчётного остатка, проведённая осознанно
	// (ЗП-4) — отличает "свободную" выплату от обычного расчёта по формуле.
	IsOverride bool `json:"is_override"`
	// Cancelled — выплата отменена (071): в ленте показывается зачёркнутой,
	// из сумм/сводки отчёта исключена, кнопки «Отменить» больше нет.
	Cancelled bool `json:"cancelled"`
}

type SalaryReportTotals struct {
	SalaryPaid  decimal.Decimal `json:"salary_paid"`
	AdvancePaid decimal.Decimal `json:"advance_paid"`
	ServicePaid decimal.Decimal `json:"service_paid"`
	Total       decimal.Decimal `json:"total"`
	Employees   int             `json:"employees"`
	Payouts     int             `json:"payouts"`
}

// payoutKind разбирает категорию (+ counterparty для легаси) в вид выплаты.
func payoutKind(category, counterparty string) string {
	switch category {
	case CategoryAdvance:
		return "advance"
	case "Сервис":
		return "service"
	case CategorySalary:
		// Легаси: аванс до разделения категорий.
		if strings.Contains(strings.ToLower(counterparty), "(аванс") {
			return "advance"
		}
		return "salary"
	}
	return "salary"
}

// SalaryReport собирает отчёт за [from, to] включительно.
//
// from/to — даты в формате YYYY-MM-DD, сравниваются со строковой колонкой
// financial_operations.date (она TEXT, см. 001_init). Строковое сравнение
// корректно ровно потому, что формат фиксирован и лексикографический порядок
// совпадает с хронологическим.
func (s *SalaryService) SalaryReport(ctx context.Context, from, to string) (*SalaryReport, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}

	type opRow struct {
		ID           string          `gorm:"column:id"`
		Date         string          `gorm:"column:date"`
		Amount       decimal.Decimal `gorm:"column:amount"`
		Category     string          `gorm:"column:category"`
		Counterparty string          `gorm:"column:counterparty"`
		SourceRef    string          `gorm:"column:source_ref"`
		AccountID    string          `gorm:"column:account_id"`
		AccountName  string          `gorm:"column:account_name"`
		PaidByName   string          `gorm:"column:paid_by_name"`
		Description  string          `gorm:"column:description"`
		IsOverride   bool            `gorm:"column:is_override"`
		Cancelled    bool            `gorm:"column:cancelled"`
		UserName     string          `gorm:"column:user_name"`
		Position     string          `gorm:"column:position"`
		Role         string          `gorm:"column:role"`
		Salary       decimal.Decimal `gorm:"column:salary"`
	}

	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	// LEFT JOIN на users по source_ref: имя сотрудника берём из карточки, а не
	// из counterparty — там лежит текст на момент выплаты («Иван (аванс)»),
	// который после переименования разъезжается. Приведение ::text обязательно:
	// users.id — UUID, source_ref — TEXT, прямое сравнение в Postgres падает.
	q := raw.Table("financial_operations AS fo").
		Select(`fo.id, COALESCE(fo.date,'') AS date, COALESCE(fo.amount,0) AS amount,
		        COALESCE(fo.category,'') AS category, COALESCE(fo.counterparty,'') AS counterparty,
		        COALESCE(fo.source_ref,'') AS source_ref,
		        COALESCE(fo.account_id,'') AS account_id, COALESCE(fo.account_name,'') AS account_name,
		        COALESCE(pr.name,'') AS paid_by_name,
		        COALESCE(fo.description,'') AS description, COALESCE(fo.is_override,false) AS is_override, (fo.cancelled_at IS NOT NULL) AS cancelled,
		        COALESCE(u.name,'') AS user_name, COALESCE(u.position,'') AS position,
		        COALESCE(u.role,'') AS role, COALESCE(u.salary,0) AS salary`).
		Joins("LEFT JOIN users u ON u.id::text = fo.source_ref").
		Joins("LEFT JOIN restaurants pr ON pr.id = fo.paid_by_restaurant_id").
		Where("fo.restaurant_id = ?", rid).
		Where("fo.category IN ?", []string{CategorySalary, CategoryAdvance, "Сервис"}).
		// Компенсирующие проводки отмен (type='in') — не выплаты: исключаем,
		// иначе отмена завышала бы суммы отчёта (см. CancelSalary/CancelAdvance).
		Where("fo.type IS DISTINCT FROM ?", "in")
	if from != "" {
		q = q.Where("fo.date >= ?", from)
	}
	if to != "" {
		q = q.Where("fo.date <= ?", to)
	}

	var ops []opRow
	if err := q.Order("fo.date DESC, fo.created_at DESC").Scan(&ops).Error; err != nil {
		return nil, err
	}

	rep := &SalaryReport{From: from, To: to}
	byUser := make(map[string]*SalaryReportRow)
	order := make([]string, 0)

	for _, op := range ops {
		kind := payoutKind(op.Category, op.Counterparty)
		name := op.UserName
		if name == "" {
			// Сотрудник удалён из карточек — показываем, как он был подписан
			// в проводке, иначе выплата исчезнет из отчёта без следа.
			name = op.Counterparty
		}

		rep.Payouts = append(rep.Payouts, SalaryPayoutRow{
			ID:          op.ID,
			Date:        op.Date,
			UserID:      op.SourceRef,
			UserName:    name,
			Kind:        kind,
			Amount:      decimal.Normalize(op.Amount),
			AccountID:   op.AccountID,
			AccountName: op.AccountName,
			PaidByName:  op.PaidByName,
			Description: op.Description,
			IsOverride:  op.IsOverride,
			Cancelled:   op.Cancelled,
		})
		// Отменённая выплата видна в ленте (зачёркнутой), но в суммы и сводку
		// «по сотрудникам» не входит — иначе отменённое считалось бы выданным.
		if op.Cancelled {
			continue
		}

		row, ok := byUser[op.SourceRef]
		if !ok {
			row = &SalaryReportRow{
				UserID:   op.SourceRef,
				UserName: name,
				Position: op.Position,
				Role:     op.Role,
				Salary:   decimal.Normalize(op.Salary),
			}
			byUser[op.SourceRef] = row
			order = append(order, op.SourceRef)
		}
		switch kind {
		case "advance":
			row.AdvancePaid = decimal.Add(row.AdvancePaid, op.Amount)
			rep.Totals.AdvancePaid = decimal.Add(rep.Totals.AdvancePaid, op.Amount)
		case "service":
			row.ServicePaid = decimal.Add(row.ServicePaid, op.Amount)
			rep.Totals.ServicePaid = decimal.Add(rep.Totals.ServicePaid, op.Amount)
		default:
			row.SalaryPaid = decimal.Add(row.SalaryPaid, op.Amount)
			rep.Totals.SalaryPaid = decimal.Add(rep.Totals.SalaryPaid, op.Amount)
		}
		row.Total = decimal.Add(row.Total, op.Amount)
		row.PayoutsCount++
		// Выборка отсортирована по дате DESC, поэтому первая встреченная
		// строка сотрудника и есть последняя выплата.
		if row.LastPayoutAt == "" {
			row.LastPayoutAt = op.Date
		}
		rep.Totals.Total = decimal.Add(rep.Totals.Total, op.Amount)
	}

	rep.Rows = make([]SalaryReportRow, 0, len(order))
	for _, id := range order {
		r := byUser[id]
		r.SalaryPaid = decimal.Normalize(r.SalaryPaid)
		r.AdvancePaid = decimal.Normalize(r.AdvancePaid)
		r.ServicePaid = decimal.Normalize(r.ServicePaid)
		r.Total = decimal.Normalize(r.Total)
		rep.Rows = append(rep.Rows, *r)
	}
	if rep.Payouts == nil {
		rep.Payouts = []SalaryPayoutRow{}
	}
	rep.Totals.SalaryPaid = decimal.Normalize(rep.Totals.SalaryPaid)
	rep.Totals.AdvancePaid = decimal.Normalize(rep.Totals.AdvancePaid)
	rep.Totals.ServicePaid = decimal.Normalize(rep.Totals.ServicePaid)
	rep.Totals.Total = decimal.Normalize(rep.Totals.Total)
	rep.Totals.Employees = len(rep.Rows)
	rep.Totals.Payouts = len(rep.Payouts)
	return rep, nil
}
