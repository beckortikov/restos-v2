package service

import (
	"context"
	"fmt"
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
)

// CancellationsReport — детальный отчёт по отменам (владелец 2026-08-29: «в
// аналитике дать возможность просматривать отменам детальный [отчёт]» — до
// этого отмены были видны только одной агрегированной цифрой в insights.go).
//
// Источники (см. orders_void.go): Cancel() (отмена ВСЕГО заказа) и
// «мягкая» pre-payment CancelItem() НЕ пишут в order_voids — только
// VoidItem() (пост-оплатное списание с approve менеджера) пишет туда
// построчно. Поэтому отчёт объединяет ДВА источника через UNION ALL, без
// риска задвоения сумм (это РАЗНЫЕ события, не дубли одного):
//   - item_void   — построчно из order_voids (та же таблица, что уже питает
//     агрегат в insights.go — цифры сопоставимы);
//   - order_cancel — целиком отменённые заказы (orders.cancelled_at NOT NULL),
//     сумма = cancelled_total.
//
// Известное ограничение v1: «мягкая» CancelItem() (до первой оплаты, без
// approve) не попадает в отчёт — order_voids не хранит order_item_id, поэтому
// надёжно отличить её от VoidItem-записей нельзя без отдельной миграции.
// Это фиксируется как гэп на будущее, а не блокирует фичу — она покрывает
// именно то, что и раньше считал агрегат в insights.go, только с деталями.
//
// Причина каскадных voids сетов хранится с префиксом "автоматически вместе
// с сетом: " (orders_void.go) — в v1 не разбираем префикс, показываем как
// есть (реже встречается, чем обычные причины, не искажает картину).
type CancellationFilter struct {
	PeriodFilter
	Limit  int
	Offset int
}

type CancellationRow struct {
	Kind           string          `gorm:"column:kind" json:"kind"` // item_void | order_cancel
	OrderID        string          `gorm:"column:order_id" json:"order_id"`
	OrderNumber    int             `gorm:"column:order_number" json:"order_number"`
	OrderType      *string         `gorm:"column:order_type" json:"order_type"`
	TableName      *string         `gorm:"column:table_name" json:"table_name"`
	ItemName       *string         `gorm:"column:item_name" json:"item_name"`
	ItemQty        *int            `gorm:"column:item_qty" json:"item_qty"`
	Amount         decimal.Decimal `gorm:"column:amount" json:"amount"`
	Reason         *string         `gorm:"column:reason" json:"reason"`
	ApprovedByName *string         `gorm:"column:approved_by_name" json:"approved_by_name"`
	CreatedByName  *string         `gorm:"column:created_by_name" json:"created_by_name"`
	CreatedAt      time.Time       `gorm:"column:created_at" json:"created_at"`
}

type CancellationBucket struct {
	Name   string          `gorm:"column:name" json:"name"`
	Amount decimal.Decimal `gorm:"column:amount" json:"amount"`
	Count  int             `gorm:"column:count" json:"count"`
}

type CancellationsSummary struct {
	TotalAmount        decimal.Decimal      `json:"total_amount"`
	ItemVoidsAmount    decimal.Decimal      `json:"item_voids_amount"`
	OrderCancelsAmount decimal.Decimal      `json:"order_cancels_amount"`
	TotalCount         int                  `json:"total_count"`
	ByReason           []CancellationBucket `json:"by_reason"`
	ByEmployee         []CancellationBucket `json:"by_employee"`
	ByDish             []CancellationBucket `json:"by_dish"`
	ByDay              []CancellationBucket `json:"by_day"`
}

type CancellationsReport struct {
	Period struct {
		From *string `json:"from,omitempty"`
		To   *string `json:"to,omitempty"`
	} `json:"period"`
	Summary CancellationsSummary `json:"summary"`
	Rows    []CancellationRow    `json:"rows"`
	Total   int64                `json:"total"`
	Limit   int                  `json:"limit"`
	Offset  int                  `json:"offset"`
}

const (
	cancellationsDefaultLimit = 50
	cancellationsMaxLimit     = 500
)

// unionSQL строит общий UNION ALL источник событий (без ORDER BY/LIMIT —
// они добавляются вызывающей стороной поверх этого же текста, аргументы
// периода/ресторана указываются дважды, по одному разу на каждую половину).
func cancellationsUnionSQL(hasFrom, hasTo bool) string {
	voidWhere := "ov.restaurant_id = ?"
	cancelWhere := "o.restaurant_id = ? AND o.cancelled_at IS NOT NULL"
	if hasFrom {
		voidWhere += " AND ov.created_at >= ?"
		cancelWhere += " AND o.cancelled_at >= ?"
	}
	if hasTo {
		voidWhere += " AND ov.created_at < ?"
		cancelWhere += " AND o.cancelled_at < ?"
	}
	return fmt.Sprintf(`
		SELECT 'item_void' AS kind, ov.order_id AS order_id, o.order_number AS order_number,
		       o.type AS order_type, t.name AS table_name, ov.item_name AS item_name,
		       ov.item_qty AS item_qty, (ov.item_price * COALESCE(ov.item_qty, 1)) AS amount,
		       ov.reason AS reason, ov.approved_by_name AS approved_by_name,
		       ov.created_by_name AS created_by_name, ov.created_at AS created_at
		FROM order_voids ov
		JOIN orders o ON o.id = ov.order_id
		LEFT JOIN tables t ON t.id::text = o.table_id
		WHERE %s
		UNION ALL
		SELECT 'order_cancel' AS kind, o.id AS order_id, o.order_number AS order_number,
		       o.type AS order_type, t.name AS table_name, NULL AS item_name,
		       NULL AS item_qty, COALESCE(o.cancelled_total, o.total, 0) AS amount,
		       o.cancel_reason AS reason, NULL AS approved_by_name,
		       u.name AS created_by_name, o.cancelled_at AS created_at
		FROM orders o
		LEFT JOIN tables t ON t.id::text = o.table_id
		LEFT JOIN users u ON u.id::text = o.cancelled_by AND u.restaurant_id = o.restaurant_id
		WHERE %s
	`, voidWhere, cancelWhere)
}

// CancellationsReport — GET /api/v1/analytics/cancellations.
func (s *AnalyticsService) CancellationsReport(ctx context.Context, f CancellationFilter) (*CancellationsReport, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	limit := f.Limit
	if limit <= 0 {
		limit = cancellationsDefaultLimit
	}
	if limit > cancellationsMaxLimit {
		limit = cancellationsMaxLimit
	}
	offset := f.Offset
	if offset < 0 {
		offset = 0
	}

	args := []any{rid}
	if f.From != nil {
		args = append(args, *f.From)
	}
	if f.To != nil {
		args = append(args, *f.To)
	}
	// Аргументы повторяются для второй половины UNION ALL (тот же rid/период).
	args = append(args, args...)
	unionSQL := cancellationsUnionSQL(f.From != nil, f.To != nil)

	out := &CancellationsReport{Rows: []CancellationRow{}}
	if f.From != nil {
		s := f.From.Format("2006-01-02")
		out.Period.From = &s
	}
	if f.To != nil {
		s := f.To.Format("2006-01-02")
		out.Period.To = &s
	}

	if err := s.r.Raw().WithContext(ctx).
		Raw(fmt.Sprintf("SELECT COUNT(*) FROM (%s) x", unionSQL), args...).
		Scan(&out.Total).Error; err != nil {
		return nil, err
	}

	pagedArgs := append(append([]any{}, args...), limit, offset)
	if err := s.r.Raw().WithContext(ctx).
		Raw(unionSQL+" ORDER BY created_at DESC LIMIT ? OFFSET ?", pagedArgs...).
		Scan(&out.Rows).Error; err != nil {
		return nil, err
	}

	// Итоги по типу события (сумма/кол-во), без пагинации.
	type kindTotal struct {
		Kind   string          `gorm:"column:kind"`
		Amount decimal.Decimal `gorm:"column:amount"`
		Count  int             `gorm:"column:count"`
	}
	var kindTotals []kindTotal
	if err := s.r.Raw().WithContext(ctx).
		Raw(fmt.Sprintf("SELECT kind, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS count FROM (%s) x GROUP BY kind", unionSQL), args...).
		Scan(&kindTotals).Error; err != nil {
		return nil, err
	}
	for _, kt := range kindTotals {
		out.Summary.TotalAmount = decimal.Add(out.Summary.TotalAmount, kt.Amount)
		out.Summary.TotalCount += kt.Count
		if kt.Kind == "item_void" {
			out.Summary.ItemVoidsAmount = kt.Amount
		} else {
			out.Summary.OrderCancelsAmount = kt.Amount
		}
	}
	out.Summary.TotalAmount = decimal.Normalize(out.Summary.TotalAmount)
	out.Summary.ItemVoidsAmount = decimal.Normalize(out.Summary.ItemVoidsAmount)
	out.Summary.OrderCancelsAmount = decimal.Normalize(out.Summary.OrderCancelsAmount)

	topN := func(groupExpr, where string) ([]CancellationBucket, error) {
		var rows []CancellationBucket
		sql := fmt.Sprintf(
			"SELECT %s AS name, COALESCE(SUM(amount),0) AS amount, COUNT(*) AS count FROM (%s) x %s GROUP BY name ORDER BY amount DESC LIMIT 10",
			groupExpr, unionSQL, where)
		if err := s.r.Raw().WithContext(ctx).Raw(sql, args...).Scan(&rows).Error; err != nil {
			return nil, err
		}
		return rows, nil
	}

	if out.Summary.ByReason, err = topN("COALESCE(reason, 'Без причины')", ""); err != nil {
		return nil, err
	}
	if out.Summary.ByEmployee, err = topN("COALESCE(created_by_name, 'Неизвестно')", ""); err != nil {
		return nil, err
	}
	// Только item_void несёт название блюда — order_cancel там NULL.
	if out.Summary.ByDish, err = topN("item_name", "WHERE item_name IS NOT NULL"); err != nil {
		return nil, err
	}
	if out.Summary.ByDay, err = topN("to_char(created_at, 'YYYY-MM-DD')", ""); err != nil {
		return nil, err
	}

	return out, nil
}
