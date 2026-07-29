package service

import (
	"context"
	"sort"
	"time"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// AccountBalanceHistory — «сколько денег было на счетах в каждый день».
//
// Почему это считает сервер, а не браузер: financial_accounts.balance — это
// скалярный остаток «сейчас», истории остатков в схеме нет вообще. Остаток на
// дату восстанавливается обратным ходом от текущего баланса:
//
//	closing(D) = balance_now − Σ net(d) для всех d > D
//
// где net(d) = приход(d) − расход(d). Клиент так посчитать не может: список
// операций у него обрезан лимитом выборки, и на длинном периоде числа поехали
// бы молча.
type AccountBalanceHistory struct {
	From     string                   `json:"from"`
	To       string                   `json:"to"`
	Accounts []AccountPeriodSummary   `json:"accounts"`
	Days     []AccountBalanceDayTotal `json:"days"`
}

// AccountPeriodSummary — счёт за период: сколько было на начало, что пришло и
// ушло, сколько стало.
type AccountPeriodSummary struct {
	AccountID   string          `json:"account_id"`
	AccountName string          `json:"account_name"`
	AccountType string          `json:"account_type"`
	Current     decimal.Decimal `json:"current_balance"`
	Opening     decimal.Decimal `json:"opening_balance"`
	In          decimal.Decimal `json:"in"`
	Out         decimal.Decimal `json:"out"`
	Closing     decimal.Decimal `json:"closing_balance"`
}

// AccountBalanceDayTotal — один день: движение и остаток на конец дня.
// PerAccount — тот же день в разрезе счетов (id → остаток на конец дня).
type AccountBalanceDayTotal struct {
	Date       string                     `json:"date"`
	In         decimal.Decimal            `json:"in"`
	Out        decimal.Decimal            `json:"out"`
	Closing    decimal.Decimal            `json:"closing_balance"`
	PerAccount map[string]decimal.Decimal `json:"per_account,omitempty"`
}

// BalanceHistory собирает остатки по дням за [from, to] включительно.
// from/to — YYYY-MM-DD. Пустой to → сегодня, пустой from → 30 дней назад.
func (s *FinancialAccountsService) BalanceHistory(ctx context.Context, from, to string) (*AccountBalanceHistory, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	now := time.Now().UTC()
	if to == "" {
		to = now.Format("2006-01-02")
	}
	if from == "" {
		from = now.AddDate(0, 0, -30).Format("2006-01-02")
	}
	if from > to {
		from, to = to, from
	}

	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var accounts []models.FinancialAccount
	if err := scoped.Order("name ASC").Find(&accounts).Error; err != nil {
		return nil, err
	}
	if len(accounts) == 0 {
		return &AccountBalanceHistory{From: from, To: to, Accounts: []AccountPeriodSummary{}, Days: []AccountBalanceDayTotal{}}, nil
	}

	// Дневные нетто по счетам, начиная с первого дня периода и до конца
	// истории: всё, что ПОЗЖЕ дня D, нужно вычесть из текущего баланса, чтобы
	// получить остаток на конец D. Операции без счёта (бухгалтерские) не
	// двигают баланс и в выборку не попадают.
	type netRow struct {
		AccountID string          `gorm:"column:account_id"`
		Date      string          `gorm:"column:date"`
		In        decimal.Decimal `gorm:"column:in_sum"`
		Out       decimal.Decimal `gorm:"column:out_sum"`
	}
	var nets []netRow
	raw := s.r.DB().Session(&gormSessionNewDB).WithContext(ctx)
	if err := raw.Table("financial_operations").
		Select(`account_id,
		        date,
		        COALESCE(SUM(CASE WHEN type = 'in'  THEN amount ELSE 0 END), 0) AS in_sum,
		        COALESCE(SUM(CASE WHEN type = 'out' THEN amount ELSE 0 END), 0) AS out_sum`).
		Where("restaurant_id = ? AND account_id IS NOT NULL AND account_id <> ''", rid).
		Where("date >= ?", from).
		Group("account_id, date").
		Scan(&nets).Error; err != nil {
		return nil, err
	}

	// netByAccDate[accID][date] = (in, out)
	type inOut struct{ In, Out decimal.Decimal }
	netByAccDate := make(map[string]map[string]inOut, len(accounts))
	for _, n := range nets {
		m := netByAccDate[n.AccountID]
		if m == nil {
			m = make(map[string]inOut)
			netByAccDate[n.AccountID] = m
		}
		m[n.Date] = inOut{In: n.In, Out: n.Out}
	}

	// Все даты периода + все даты операций ПОСЛЕ периода (их движение нужно
	// вычесть, но самих дней в ответе быть не должно).
	days := enumerateDays(from, to)
	laterDates := map[string]bool{}
	for _, m := range netByAccDate {
		for d := range m {
			if d > to {
				laterDates[d] = true
			}
		}
	}

	summaries := make([]AccountPeriodSummary, 0, len(accounts))
	// closingByAcc[accID][date] — остаток счёта на конец дня.
	closingByAcc := make(map[string]map[string]decimal.Decimal, len(accounts))

	for _, acc := range accounts {
		name := ""
		if acc.Name != nil {
			name = *acc.Name
		}
		typ := ""
		if acc.Type != nil {
			typ = *acc.Type
		}
		perDate := netByAccDate[acc.ID]

		// Откатываем текущий баланс назад через все дни ПОСЛЕ конца периода.
		balance := acc.Balance
		later := make([]string, 0, len(laterDates))
		for d := range laterDates {
			later = append(later, d)
		}
		sort.Strings(later)
		for i := len(later) - 1; i >= 0; i-- {
			io := perDate[later[i]]
			balance = decimal.Sub(balance, decimal.Sub(io.In, io.Out))
		}
		// balance == остаток на конец дня `to`.

		closings := make(map[string]decimal.Decimal, len(days))
		periodIn, periodOut := decimal.Zero, decimal.Zero
		running := balance
		for i := len(days) - 1; i >= 0; i-- {
			d := days[i]
			closings[d] = running
			io := perDate[d]
			periodIn = decimal.Add(periodIn, io.In)
			periodOut = decimal.Add(periodOut, io.Out)
			// Остаток на конец предыдущего дня = текущий минус движение дня.
			running = decimal.Sub(running, decimal.Sub(io.In, io.Out))
		}
		closingByAcc[acc.ID] = closings

		summaries = append(summaries, AccountPeriodSummary{
			AccountID:   acc.ID,
			AccountName: name,
			AccountType: typ,
			Current:     decimal.Normalize(acc.Balance),
			// running после цикла — остаток на конец дня ПЕРЕД периодом.
			Opening: decimal.Normalize(running),
			In:      decimal.Normalize(periodIn),
			Out:     decimal.Normalize(periodOut),
			Closing: decimal.Normalize(balance),
		})
	}

	// Сводка по дням: движение и остаток по всем счетам вместе.
	out := make([]AccountBalanceDayTotal, 0, len(days))
	for _, d := range days {
		row := AccountBalanceDayTotal{Date: d, PerAccount: make(map[string]decimal.Decimal, len(accounts))}
		for _, acc := range accounts {
			io := netByAccDate[acc.ID][d]
			row.In = decimal.Add(row.In, io.In)
			row.Out = decimal.Add(row.Out, io.Out)
			c := closingByAcc[acc.ID][d]
			row.Closing = decimal.Add(row.Closing, c)
			row.PerAccount[acc.ID] = decimal.Normalize(c)
		}
		row.In = decimal.Normalize(row.In)
		row.Out = decimal.Normalize(row.Out)
		row.Closing = decimal.Normalize(row.Closing)
		out = append(out, row)
	}

	return &AccountBalanceHistory{From: from, To: to, Accounts: summaries, Days: out}, nil
}

// enumerateDays — список дат YYYY-MM-DD от from до to включительно.
// Ограничен 400 днями: экран показывает таблицу, а не годовой ряд, и без
// потолка кривой ввод дат («2000-01-01») сгенерировал бы десятки тысяч строк.
func enumerateDays(from, to string) []string {
	start, err1 := time.Parse("2006-01-02", from)
	end, err2 := time.Parse("2006-01-02", to)
	if err1 != nil || err2 != nil || end.Before(start) {
		return []string{}
	}
	const maxDays = 400
	days := make([]string, 0, 32)
	for d := start; !d.After(end) && len(days) < maxDays; d = d.AddDate(0, 0, 1) {
		days = append(days, d.Format("2006-01-02"))
	}
	return days
}
