package service

import (
	"context"
	"errors"
	"io"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/pkg/xlsx"
	"github.com/restos/restos-v4/server/internal/repo"
)

// ReportsService — генерация xlsx-отчётов.
//
// Все экспорты пишут напрямую в io.Writer (HTTP response), без буферизации
// всего файла в memory. Для отчётов на 100k+ строк это критично.
type ReportsService struct {
	r *repo.Repo
}

func NewReportsService(r *repo.Repo) *ReportsService { return &ReportsService{r: r} }

// PeriodFilter — общий для отчётов «с N по M».
type PeriodFilter struct {
	From *time.Time
	To   *time.Time
}

// ─── orders.xlsx ───────────────────────────────────────────────────────────

// OrdersReport — все заказы ресторана за период (закрытые/отменённые/открытые).
//
// Один лист "Orders": № заказа, дата, тип, стол, официант, total, метод оплаты,
// статус, причина отмены.
func (s *ReportsService) OrdersReport(ctx context.Context, f PeriodFilter, w io.Writer) error {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	q := scoped.Order("created_at DESC")
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	var orders []models.Order
	if err := q.Find(&orders).Error; err != nil {
		return err
	}

	sh := xlsx.New("Orders")
	defer sh.Close()
	sh.Header("№", "Дата", "Тип", "Стол", "Официант", "Гости",
		"Сумма", "Сервис", "Итого", "Оплата", "Статус", "Причина отмены")
	for _, o := range orders {
		sh.AddRow(
			o.OrderNumber,
			o.CreatedAt,
			strOrEmpty(o.Type),
			strOrEmpty(o.TableID),
			strOrEmpty(o.WaiterID),
			intOrZero(o.GuestsCount),
			o.Total,
			o.ServiceAmount,
			o.TotalWithService,
			strOrEmpty(o.PaymentMethod),
			strOrEmpty(o.Status),
			strOrEmpty(o.CancelReason),
		)
	}
	_ = rid
	_, err = sh.WriteTo(w)
	return err
}

// ─── shift Z-report.xlsx ───────────────────────────────────────────────────

// ShiftReport — Z-отчёт смены: header (агрегаты) + операции + заказы.
// Три листа в одной книге.
func (s *ReportsService) ShiftReport(ctx context.Context, shiftID string, w io.Writer) error {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return err
	}
	scoped, _ := s.r.ForTenant(ctx)
	var shift models.CashShift
	if err := scoped.Where("id = ?", shiftID).First(&shift).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return apperrors.ErrNotFound
		}
		return err
	}

	// Лист 1 — Summary.
	sh := xlsx.New("Summary")
	defer sh.Close()
	sh.Header("Параметр", "Значение")
	sh.AddRow("Смена ID", shift.ID)
	sh.AddRow("Статус", strOrEmpty(shift.Status))
	sh.AddRow("Открыта", shift.OpenedAt)
	if shift.ClosedAt != nil {
		sh.AddRow("Закрыта", *shift.ClosedAt)
	}
	sh.AddRow("Открыл", strOrEmpty(shift.OpenedBy))
	if shift.ClosedBy != nil {
		sh.AddRow("Закрыл", *shift.ClosedBy)
	}
	sh.AddRow("Начальный баланс", shift.OpeningBalance)
	sh.AddRow("Наличная выручка", shift.CashRevenue)
	sh.AddRow("Безналичная выручка", shift.CardRevenue)
	sh.AddRow("Заказов", intOrZero(shift.OrdersCount))
	sh.AddRow("Средний чек", shift.AvgCheck)
	if shift.ExpectedCash != nil {
		sh.AddRow("Ожидается в кассе", *shift.ExpectedCash)
	}
	sh.AddRow("Фактически в кассе", shift.ClosingBalance)

	// Лист 2 — Operations.
	opsSheet := sh.AddSheet("Operations")
	opsSheet.Header("Тип", "Сумма", "Описание", "Создал", "Время")
	freshRaw := func() *gorm.DB {
		return s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	}
	var ops []models.CashShiftOperation
	if err := freshRaw().Where("shift_id = ?", shiftID).Order("created_at ASC").
		Find(&ops).Error; err != nil {
		return err
	}
	for _, op := range ops {
		opsSheet.AddRow(
			strOrEmpty(op.Type),
			op.Amount,
			strOrEmpty(op.Description),
			strOrEmpty(op.CreatedBy),
			op.CreatedAt,
		)
	}

	// Лист 3 — Orders.
	ordSheet := sh.AddSheet("Orders")
	ordSheet.Header("№", "Время", "Тип", "Итого", "Оплата", "Статус")
	scopedFresh, _ := s.r.ForTenant(ctx)
	var orders []models.Order
	if err := scopedFresh.Where("shift_id = ?", shiftID).Order("created_at ASC").
		Find(&orders).Error; err != nil {
		return err
	}
	for _, o := range orders {
		ordSheet.AddRow(
			o.OrderNumber,
			o.CreatedAt,
			strOrEmpty(o.Type),
			o.TotalWithService,
			strOrEmpty(o.PaymentMethod),
			strOrEmpty(o.Status),
		)
	}

	_ = rid
	_, err = sh.WriteTo(w)
	return err
}

// ─── stock-movements.xlsx ──────────────────────────────────────────────────

// StockMovementsReport — append-only лог движений склада за период.
type StockMovementsReport struct {
	Period       PeriodFilter
	IngredientID string // если задан — фильтр
}

func (s *ReportsService) StockMovements(ctx context.Context, f StockMovementsReport, w io.Writer) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	q := scoped.Order("created_at ASC")
	if f.Period.From != nil {
		q = q.Where("created_at >= ?", *f.Period.From)
	}
	if f.Period.To != nil {
		q = q.Where("created_at < ?", *f.Period.To)
	}
	if f.IngredientID != "" {
		q = q.Where("ingredient_id = ?", f.IngredientID)
	}
	var mvs []models.StockMovement
	if err := q.Find(&mvs).Error; err != nil {
		return err
	}

	sh := xlsx.New("Stock movements")
	defer sh.Close()
	sh.Header("Время", "Тип", "Ингредиент", "Кол-во", "Ед.", "Описание", "Ниже 0")
	for _, m := range mvs {
		sh.AddRow(
			m.CreatedAt,
			strOrEmpty(m.Type),
			strOrEmpty(m.IngredientName),
			m.Qty,
			strOrEmpty(m.Unit),
			strOrEmpty(m.Description),
			boolOrFalse(m.BelowZero),
		)
	}
	_, err = sh.WriteTo(w)
	return err
}

// ─── audit.xlsx ───────────────────────────────────────────────────────────

// AuditReport — лог мутаций ресторана за период.
func (s *ReportsService) AuditReport(ctx context.Context, f PeriodFilter, w io.Writer) error {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return err
	}
	q := scoped.Order("created_at ASC")
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	var logs []models.AuditLog
	if err := q.Find(&logs).Error; err != nil {
		return err
	}

	sh := xlsx.New("Audit")
	defer sh.Close()
	sh.Header("Время", "Действие", "Сущность", "ID", "Имя", "Пользователь")
	for _, l := range logs {
		sh.AddRow(
			l.CreatedAt,
			strOrEmpty(l.Action),
			strOrEmpty(l.EntityType),
			strOrEmpty(l.EntityID),
			strOrEmpty(l.EntityName),
			strOrEmpty(l.UserName),
		)
	}
	_, err = sh.WriteTo(w)
	return err
}

// ─── helpers ──────────────────────────────────────────────────────────────

func strOrEmpty(p *string) string {
	if p == nil {
		return ""
	}
	return *p
}

func intOrZero(p *int) int {
	if p == nil {
		return 0
	}
	return *p
}

func boolOrFalse(p *bool) bool {
	if p == nil {
		return false
	}
	return *p
}
