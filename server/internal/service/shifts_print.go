package service

import (
	"context"
	"errors"
	"fmt"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/escpos"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// PrintZResult — единый ответ для печати X/Z отчёта.
type PrintZResult struct {
	JobID  string `json:"job_id"`
	Status string `json:"status"`
}

// PrintZ — POST /api/v1/shifts/{id}/print-z.
//
// Собирает агрегаты смены (Z-отчёт), строит ESC/POS layout через
// escpos.ZReportLayout и кладёт PrintJob type='z_report' в очередь.
// Реальная отправка на принтер — асинхронным воркером.
//
// Не меняет статус смены: смена должна быть уже закрыта (Z = финальный отчёт).
// Для промежуточного отчёта используем PrintX.
func (s *ShiftsService) PrintZ(ctx context.Context, shiftID string) (*PrintZResult, error) {
	return s.printReport(ctx, shiftID, "z_report", true)
}

// PrintX — POST /api/v1/shifts/{id}/print-x.
//
// Промежуточный отчёт (без обнуления). Работает и для открытой, и для
// закрытой смены. Type job = 'x_report'.
func (s *ShiftsService) PrintX(ctx context.Context, shiftID string) (*PrintZResult, error) {
	return s.printReport(ctx, shiftID, "x_report", false)
}

func (s *ShiftsService) printReport(ctx context.Context, shiftID, jobType string, isZ bool) (*PrintZResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}

	// 1. Подтянем агрегаты через ZReport (общий метод покрывает оба отчёта).
	zr, err := s.ZReport(ctx, shiftID)
	if err != nil {
		return nil, err
	}

	// 2. Restaurant header.
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&rest).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}

	// 3. Имя кассира — closed_by для Z, opened_by для X (best-effort).
	var cashierName string
	var userIDRef *string
	if isZ && zr.Shift.ClosedBy != nil {
		userIDRef = zr.Shift.ClosedBy
	} else if zr.Shift.OpenedBy != nil {
		userIDRef = zr.Shift.OpenedBy
	}
	if userIDRef != nil && *userIDRef != "" {
		var u struct {
			Name string `gorm:"column:name"`
		}
		_ = s.r.Raw().WithContext(ctx).Table("users").
			Select("name").Where("id = ?", *userIDRef).Scan(&u).Error
		cashierName = u.Name
	}

	// 4. Build ReportInput. shift_number — короткий идентификатор (последние 6 hex).
	shiftNumber := zr.Shift.ID
	if len(shiftNumber) > 6 {
		shiftNumber = shiftNumber[len(shiftNumber)-6:]
	}
	// Дата в местном поясе кассы (как и остальные времена на чеке/отчёте).
	shiftNumber = fmt.Sprintf("%s (%s)", shiftNumber, zr.Shift.OpenedAt.Local().Format("02.01.2006"))

	in := escpos.ReportInput{
		RestaurantName: rest.Name,
		ShiftNumber:    shiftNumber,
		OpenedAt:       zr.Shift.OpenedAt,
		OpeningBalance: zr.Shift.OpeningBalance,
		CashRevenue:    zr.Shift.CashRevenue,
		CardRevenue:    zr.Shift.CardRevenue,
		OrdersCount:    zr.Shift.OrdersCount,
		AvgCheck:       zr.Shift.AvgCheck,
		ClosingBalance: zr.Shift.ClosingBalance,
		CashierName:    cashierName,
		CashIn:         zr.CashIn,
		Withdrawals:    zr.Withdrawals,
	}
	// «Расходы» в печати — ВСЕ расходы бизнеса (нал+безнал), чтобы безналичные
	// закупки тоже были видны. «Ожидается в кассе» ниже считается по наличной
	// ExpensesByCategory (безнал ящик не трогает) — печатная строка расходов и
	// касса-остаток намеренно про разное.
	for _, e := range zr.ExpensesByCategoryAll {
		in.Expenses = append(in.Expenses, escpos.ReportExpenseLine{Category: e.Category, Amount: e.Amount})
	}
	// Безнал в разрезе счетов: под строкой «Безнал. выручка» печатаем каждую
	// карту/терминал отдельно (Банк А: 10, Банк Б: 20), а не одну общую сумму.
	for _, rm := range zr.RevenueByMethod {
		if rm.PaymentMethod == "cash" {
			continue
		}
		name := rm.AccountName
		if name == "" {
			name = "Безнал. счёт"
		}
		in.CardByBank = append(in.CardByBank, escpos.ReportBankLine{Name: name, Amount: rm.Total})
	}
	if zr.Shift.ClosedAt != nil {
		in.ClosedAt = *zr.Shift.ClosedAt
	}
	// Ожидается в кассе: для закрытой смены берём зафиксированное значение; иначе
	// (печать Z до закрытия / значение не проставлено) считаем на лету ТОЙ ЖЕ
	// формулой, что и при закрытии: opening + cash_revenue + cash_in − изъятия −
	// расходы. Без этого строка показывала 0.
	if zr.Shift.ExpectedCash != nil {
		in.ExpectedCash = *zr.Shift.ExpectedCash
	} else {
		expensesTotal := decimal.Zero
		for _, e := range zr.ExpensesByCategory {
			expensesTotal = decimal.Add(expensesTotal, e.Amount)
		}
		base := decimal.Add(decimal.Add(zr.Shift.OpeningBalance, zr.Shift.CashRevenue), zr.CashIn)
		in.ExpectedCash = decimal.Normalize(decimal.Sub(decimal.Sub(base, zr.Withdrawals), expensesTotal))
	}

	var payload []byte
	// Кодовая страница принтера — иначе отчёт печатается дефолтной таблицей
	// и на принтерах с другой нумерацией выходит мусором вместо кириллицы.
	if rp, ok := receiptPrinterFor(s.r.Raw().WithContext(ctx), rid); ok {
		in.Codepage = byte(rp.Codepage)
	}
	if isZ {
		payload = escpos.ZReportLayout(in)
	} else {
		payload = escpos.XReportLayout(in)
	}

	// 5. Enqueue print_job.
	now := time.Now().UTC()
	pj := &models.PrintJob{
		ID:           uuid.NewString(),
		Type:         jobType,
		Payload:      payload,
		Status:       "pending",
		RestaurantID: &rid,
		CreatedAt:    now,
		UpdatedAt:    now,
	}

	var res PrintZResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Session(&gorm.Session{SkipHooks: true}).Create(pj).Error; err != nil {
			return err
		}
		res.JobID = pj.ID
		res.Status = pj.Status
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// PrintService — POST /api/v1/shifts/{id}/print-service.
//
// Чек «Обслуживание официантов» за смену: по каждому официанту начислено
// (зафиксированный service_amount закрытых заказов), выплачено и к выплате.
// Кнопка стоит рядом с X/Z-отчётом. Работает и для открытой, и для закрытой смены.
func (s *ShiftsService) PrintService(ctx context.Context, shiftID string) (*PrintZResult, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}

	var shift models.CashShift
	if err := s.r.Raw().WithContext(ctx).Where("id = ? AND restaurant_id = ?", shiftID, rid).First(&shift).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	var rest models.Restaurant
	if err := s.r.Raw().WithContext(ctx).Where("id = ?", rid).First(&rest).Error; err != nil {
		return nil, err
	}

	// Начислено по официантам — зафиксированный o.service_amount закрытых заказов смены.
	type accRow struct {
		WaiterID string          `gorm:"column:waiter_id"`
		Name     string          `gorm:"column:name"`
		Accrued  decimal.Decimal `gorm:"column:accrued"`
	}
	var accRows []accRow
	if err := s.r.Raw().WithContext(ctx).
		Table("orders AS o").
		Select("COALESCE(o.waiter_id::text,'') AS waiter_id, COALESCE(u.name,'') AS name, COALESCE(SUM(o.service_amount),0) AS accrued").
		Joins("LEFT JOIN users u ON u.id::text = o.waiter_id::text").
		Where("o.restaurant_id = ? AND o.status = ? AND o.closed_at IS NOT NULL AND o.waiter_id IS NOT NULL AND o.shift_id = ?", rid, "closed", shiftID).
		Group("o.waiter_id, u.name").
		Order("u.name ASC").
		Scan(&accRows).Error; err != nil {
		return nil, err
	}

	// Выплачено по официантам — financial_operations type=out, категория «Сервис%».
	type payRow struct {
		WaiterID string          `gorm:"column:waiter_id"`
		Paid     decimal.Decimal `gorm:"column:paid"`
	}
	var payRows []payRow
	if err := s.r.Raw().WithContext(ctx).
		Table("financial_operations AS fo").
		Select("COALESCE(fo.source_ref,'') AS waiter_id, COALESCE(SUM(fo.amount),0) AS paid").
		Where("fo.restaurant_id = ? AND fo.type = ? AND fo.category ILIKE ? AND fo.shift_id = ?", rid, "out", "Сервис%", shiftID).
		Group("fo.source_ref").
		Scan(&payRows).Error; err != nil {
		return nil, err
	}
	paidByWaiter := make(map[string]decimal.Decimal, len(payRows))
	for _, p := range payRows {
		paidByWaiter[p.WaiterID] = decimal.Normalize(p.Paid)
	}

	waiters := make([]escpos.ServiceWaiterLine, 0, len(accRows))
	for _, a := range accRows {
		accrued := decimal.Normalize(a.Accrued)
		paid := paidByWaiter[a.WaiterID]
		toPay := decimal.Sub(accrued, paid)
		if decimal.IsNegative(toPay) {
			toPay = decimal.Zero
		}
		name := a.Name
		if name == "" {
			name = "Без официанта"
		}
		waiters = append(waiters, escpos.ServiceWaiterLine{
			Name: name, Accrued: accrued, Paid: paid, ToPay: decimal.Normalize(toPay),
		})
	}

	shiftNumber := shift.ID
	if len(shiftNumber) > 6 {
		shiftNumber = shiftNumber[len(shiftNumber)-6:]
	}
	shiftNumber = fmt.Sprintf("%s (%s)", shiftNumber, shift.OpenedAt.Local().Format("02.01.2006"))

	in := escpos.ServiceReportInput{
		RestaurantName: rest.Name,
		ShiftNumber:    shiftNumber,
		OpenedAt:       shift.OpenedAt,
		Waiters:        waiters,
	}
	if shift.ClosedAt != nil {
		in.ClosedAt = *shift.ClosedAt
	}
	if rp, ok := receiptPrinterFor(s.r.Raw().WithContext(ctx), rid); ok {
		in.Codepage = byte(rp.Codepage)
	}
	payload := escpos.ServiceReportLayout(in)

	now := time.Now().UTC()
	pj := &models.PrintJob{
		ID:           uuid.NewString(),
		Type:         "service_report",
		Payload:      payload,
		Status:       "pending",
		RestaurantID: &rid,
		CreatedAt:    now,
		UpdatedAt:    now,
	}
	var res PrintZResult
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)
		if err := tx.Session(&gorm.Session{SkipHooks: true}).Create(pj).Error; err != nil {
			return err
		}
		res.JobID = pj.ID
		res.Status = pj.Status
		return nil
	})
	if err != nil {
		return nil, err
	}
	return &res, nil
}

// ─── Previous-shift summary (delta-chip) ───────────────────────────────────

// PreviousSummary — выжимка предыдущей закрытой смены того же ресторана.
// Возвращается внутри ZReport как поле `previous`; nil — если предыдущей нет.
type PreviousSummary struct {
	Revenue     decimal.Decimal `json:"revenue"`
	OrdersCount int             `json:"orders_count"`
	AvgCheck    decimal.Decimal `json:"avg_check"`
	GuestsCount int             `json:"guests_count"`
	ClosedAt    *time.Time      `json:"closed_at,omitempty"`
}

// loadPreviousSummary — находит ближайшую закрытую смену перед текущей и
// собирает её агрегаты (revenue = cash + card; guests count — SUM по
// заказам с GREATEST(guests_count, 1)).
//
// Возвращает (nil, nil), если предыдущей смены нет (первая смена ресторана).
func (s *ShiftsService) loadPreviousSummary(ctx context.Context, current *models.CashShift) (*PreviousSummary, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}

	// Ищем ближайшую закрытую смену с closed_at < current.opened_at.
	var prev models.CashShift
	q := s.r.Raw().WithContext(ctx).
		Where("restaurant_id = ? AND status = ? AND id != ?", rid, "closed", current.ID).
		Where("closed_at IS NOT NULL AND closed_at < ?", current.OpenedAt).
		Order("closed_at DESC").
		Limit(1)
	if err := q.First(&prev).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, nil
		}
		return nil, err
	}

	out := &PreviousSummary{
		Revenue:  decimal.Normalize(decimal.Add(prev.CashRevenue, prev.CardRevenue)),
		AvgCheck: decimal.Normalize(prev.AvgCheck),
		ClosedAt: prev.ClosedAt,
	}
	if prev.OrdersCount != nil {
		out.OrdersCount = *prev.OrdersCount
	}

	// Гости — суммируем по orders предыдущей смены (как в ZReport).
	var guests struct {
		N int `gorm:"column:n"`
	}
	if err := s.r.Raw().WithContext(ctx).
		Model(&models.Order{}).
		Select("COALESCE(SUM(GREATEST(guests_count, 1)), 0) AS n").
		Where("restaurant_id = ? AND shift_id = ? AND status = ?", rid, prev.ID, "closed").
		Scan(&guests).Error; err == nil {
		out.GuestsCount = guests.N
	}

	return out, nil
}
