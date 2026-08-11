package service

import (
	"context"
	"time"

	"github.com/google/uuid"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/audit"
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

// KDSService — кухонный дисплей (Kitchen Display System).
//
// KDS работает на уровне ПОЗИЦИЙ заказа (order_items), а не заказов: каждое
// блюдо готовится отдельно (часто на разных станциях) и двигается независимо
// по статусам pending → cooking → ready → served (миграция 033).
//
// Отмена позиции (order_items.cancelled_at) в список НЕ попадает — она
// доставляется отдельным SSE-событием order.item.voided, чтобы KDS проиграл
// звук и показал алерт, а не держал отменённое блюдо на доске.
type KDSService struct {
	r   *repo.Repo
	pub *EventPublisher
}

func NewKDSService(r *repo.Repo) *KDSService { return &KDSService{r: r} }

// WithPublisher — fluent setter (как в OrdersService).
func (s *KDSService) WithPublisher(pub *EventPublisher) *KDSService {
	s.pub = pub
	return s
}

// KDSStatuses — статусы позиции, которые KDS показывает по умолчанию (в работе).
var KDSStatuses = []string{"pending", "cooking", "ready"}

var kdsStatusSet = map[string]bool{"pending": true, "cooking": true, "ready": true, "served": true}

// KDSItem — блюдо на кухонной доске (одна карточка).
type KDSItem struct {
	ID          string  `json:"id"`
	OrderID     string  `json:"order_id"`
	OrderNumber int     `json:"order_number"`
	OrderType   string  `json:"order_type"`
	TableNumber *int    `json:"table_number"`
	TableName   *string `json:"table_name"`
	Name        string  `json:"name"`
	Qty         string  `json:"qty"`
	// Unit — единица позиции: "g"/"kg" (весовое блюдо, qty = вес) или piece/пусто
	// (штучное, qty = количество). Кухня по нему решает: «100 г» или «×100».
	Unit          string    `json:"unit"`
	Comment       *string   `json:"comment"`
	Station       string    `json:"station"`
	StationStatus string    `json:"station_status"`
	WaiterName    *string   `json:"waiter_name"`
	CreatedAt     time.Time `json:"created_at"`
	// AgeSeconds — сколько секунд назад создано блюдо, по ЧАСАМ СЕРВЕРА. Кухонный
	// планшет считает «сколько прошло» от него, а не от своих часов (которые
	// часто выставлены криво → таймер застревал на «0 мин»).
	AgeSeconds int64      `json:"age_seconds"`
	StatusAt   *time.Time `json:"status_at"`
}

type kdsRow struct {
	ID            string
	OrderID       string
	Name          *string
	Qty           decimal.Decimal
	Unit          *string
	Comment       *string
	StationStatus string
	StatusAt      *time.Time
	CreatedAt     time.Time
	Station       string
	OrderNumber   int
	OrderType     *string
	TableNumber   *int
	TableName     *string
	WaiterName    *string
}

// ListItems возвращает блюда «в работе» для указанных станций и статусов,
// отсортированные по времени создания (FIFO — старые сверху).
//
// stations пустой → все станции; statuses пустой → KDSStatuses (в работе).
func (s *KDSService) ListItems(ctx context.Context, stations, statuses []string) ([]KDSItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if len(statuses) == 0 {
		statuses = KDSStatuses
	}

	// KDS — «текущая смена», а не «созданные сегодня». Раньше граница была
	// created_at >= startOfToday (полночь по часам сервера) — если смена шла
	// через полночь, ещё не выданный заказ мгновенно пропадал с доски ровно в
	// 00:00, хотя повар его ещё не приготовил.
	//
	// Граница — МОМЕНТ ОТКРЫТИЯ самой ранней из сейчас открытых смен (если она
	// есть), иначе — как раньше, начало календарного дня. Специально НЕ через
	// shift_id: официантские заказы с Kotlin-планшета создаются без привязки к
	// кассовой смене — жёсткий фильтр по shift_id уже пробовали в
	// pos2/order/page.tsx и откатили именно из-за этого (см. комментарий там,
	// строки ~744-751): такие заказы пропадали. Временна́я граница включает их
	// всех, независимо от shift_id.
	now := time.Now()
	boundary := time.Date(now.Year(), now.Month(), now.Day(), 0, 0, 0, 0, now.Location())
	var earliestOpenShift time.Time
	if err := s.r.Raw().WithContext(ctx).Model(&models.CashShift{}).
		Select("MIN(opened_at)").
		Where("restaurant_id = ? AND status = ?", rid, "open").
		Scan(&earliestOpenShift).Error; err == nil && !earliestOpenShift.IsZero() && earliestOpenShift.Before(boundary) {
		boundary = earliestOpenShift
	}

	q := s.r.Raw().WithContext(ctx).
		Table("order_items AS oi").
		Select(`oi.id, oi.order_id, oi.name, oi.qty, oi.unit, oi.note AS comment,
			oi.station_status, oi.station_status_at AS status_at, oi.created_at,
			COALESCE(mi.station, 'hot_kitchen') AS station,
			o.order_number, o.type AS order_type,
			t.number AS table_number, t.name AS table_name,
			u.name AS waiter_name`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id").
		Joins("LEFT JOIN tables t ON t.id::text = o.table_id").
		Joins("LEFT JOIN users u ON u.id::text = o.waiter_id").
		Where("o.restaurant_id = ?", rid).
		Where("oi.cancelled_at IS NULL").
		Where("o.status NOT IN ?", []string{"done", "served", "cancelled"}).
		Where("o.created_at >= ?", boundary).
		Where("oi.station_status IN ?", statuses)
	if len(stations) > 0 {
		q = q.Where("COALESCE(mi.station, 'hot_kitchen') IN ?", stations)
	}

	var rows []kdsRow
	if err := q.Order("oi.created_at ASC").Scan(&rows).Error; err != nil {
		return nil, err
	}

	out := make([]KDSItem, 0, len(rows))
	nowUTC := time.Now()
	for _, r := range rows {
		name := ""
		if r.Name != nil {
			name = *r.Name
		}
		orderType := "hall"
		if r.OrderType != nil && *r.OrderType != "" {
			orderType = *r.OrderType
		}
		ageSeconds := int64(nowUTC.Sub(r.CreatedAt).Seconds())
		if ageSeconds < 0 {
			ageSeconds = 0
		}
		out = append(out, KDSItem{
			ID:            r.ID,
			OrderID:       r.OrderID,
			OrderNumber:   r.OrderNumber,
			OrderType:     orderType,
			TableNumber:   r.TableNumber,
			TableName:     r.TableName,
			Name:          name,
			Qty:           r.Qty.String(),
			Unit:          deref(r.Unit),
			Comment:       r.Comment,
			Station:       r.Station,
			StationStatus: r.StationStatus,
			WaiterName:    r.WaiterName,
			CreatedAt:     r.CreatedAt,
			AgeSeconds:    ageSeconds,
			StatusAt:      r.StatusAt,
		})
	}
	return out, nil
}

// ListStations — станции ресторана (уникальные menu_items.station) для настройки
// KDS-дисплея. Клиент показывает их в выборе станций вместо хардкода.
func (s *KDSService) ListStations(ctx context.Context) ([]string, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	var stations []string
	err = s.r.Raw().WithContext(ctx).
		Model(&models.MenuItem{}).
		Where("restaurant_id = ? AND station IS NOT NULL AND station <> ''", rid).
		Distinct().
		Order("station").
		Pluck("station", &stations).Error
	if err != nil {
		return nil, err
	}
	return stations, nil
}

// CallWaiter — повар нажал «колокольчик» на карточке блюда: шлём официанту,
// оформившему заказ, уведомление «приходи на кухню». Ничего не пишем в БД —
// это fire-and-forget сигнал по SSE (kds.waiter.called), официант фильтрует по
// своему waiter_id (как уведомления о готовности).
//
// Возвращает имя официанта (для подтверждения на кухне) или ошибку, если у
// заказа нет официанта (некому звонить).
func (s *KDSService) CallWaiter(ctx context.Context, itemID string) (string, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return "", err
	}

	var row struct {
		WaiterID    *string `gorm:"column:waiter_id"`
		WaiterName  *string `gorm:"column:waiter_name"`
		OrderNumber int     `gorm:"column:order_number"`
		OrderType   *string `gorm:"column:order_type"`
		TableNumber *int    `gorm:"column:table_number"`
		TableName   *string `gorm:"column:table_name"`
		DishName    *string `gorm:"column:dish_name"`
	}
	err = s.r.Raw().WithContext(ctx).
		Table("order_items AS oi").
		Select(`o.waiter_id AS waiter_id, u.name AS waiter_name,
			o.order_number, o.type AS order_type,
			t.number AS table_number, t.name AS table_name,
			oi.name AS dish_name`).
		Joins("JOIN orders o ON o.id = oi.order_id").
		Joins("LEFT JOIN users u ON u.id::text = o.waiter_id").
		Joins("LEFT JOIN tables t ON t.id::text = o.table_id").
		Where("oi.id = ? AND o.restaurant_id = ?", itemID, rid).
		// Take, а не First: First навешивает ORDER BY по «первичному ключу»
		// целевой структуры (oi.waiter_id — такой колонки нет), падает 42703.
		Take(&row).Error
	if err != nil {
		if err == gorm.ErrRecordNotFound {
			return "", apperrors.Wrap("NOT_FOUND", "order item not found", nil)
		}
		return "", err
	}
	if row.WaiterID == nil || *row.WaiterID == "" {
		return "", apperrors.Wrap("VALIDATION", "у заказа нет официанта", nil)
	}

	waiterName := ""
	if row.WaiterName != nil {
		waiterName = *row.WaiterName
	}
	if s.pub != nil {
		buf := NewBuffer()
		buf.Add(EventKDSWaiterCalled, map[string]any{
			"waiter_id":    *row.WaiterID,
			"waiter_name":  waiterName,
			"order_number": row.OrderNumber,
			"order_type":   deref(row.OrderType),
			"table_number": row.TableNumber,
			"table_name":   deref(row.TableName),
			"name":         deref(row.DishName),
		})
		s.pub.Flush(ctx, rid, buf)
	}
	return waiterName, nil
}

// SetItemStatus переводит одну позицию в указанный статус (кнопка на карточке:
// В ГОТОВКУ → cooking, ГОТОВО → ready, ВЫДАНО → served). Идемпотентно:
// повторная установка того же статуса — no-op-успех.
//
// Смена статуса на кухне НЕ трогает orders.status и склад — это отдельная
// плоскость KDS. Списание ингредиентов остаётся на существующем потоке заказа.
func (s *KDSService) SetItemStatus(ctx context.Context, itemID, status string) (*KDSItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	if !kdsStatusSet[status] {
		return nil, apperrors.Wrap("VALIDATION", "invalid station_status", nil)
	}

	buf := NewBuffer()
	err = s.r.Transaction(ctx, func(tr *repo.Repo) error {
		tx := tr.Raw().WithContext(ctx)

		// Позиция + контекст заказа (waiter_id/order_number для адресного
		// уведомления официанту). tenant-проверка через JOIN на orders.
		var row struct {
			models.OrderItem
			WaiterID    *string `gorm:"column:waiter_id"`
			OrderNumber int     `gorm:"column:order_number"`
			Station     string  `gorm:"column:station"`
		}
		err := tx.Table("order_items AS oi").
			Select(`oi.*, o.waiter_id AS waiter_id, o.order_number AS order_number,
				COALESCE(mi.station, 'hot_kitchen') AS station`).
			Joins("JOIN orders o ON o.id = oi.order_id").
			Joins("LEFT JOIN menu_items mi ON mi.id = oi.menu_item_id").
			Where("oi.id = ? AND o.restaurant_id = ?", itemID, rid).
			First(&row).Error
		if err != nil {
			if err == gorm.ErrRecordNotFound {
				return apperrors.Wrap("NOT_FOUND", "order item not found", nil)
			}
			return err
		}
		if row.CancelledAt != nil {
			return apperrors.Wrap("VALIDATION", "item is cancelled", nil)
		}

		now := time.Now().UTC()
		if err := tx.Model(&models.OrderItem{}).
			Where("id = ?", itemID).
			Updates(map[string]any{"station_status": status, "station_status_at": now}).Error; err != nil {
			return err
		}
		// Событие в лог стадий — только на РЕАЛЬНЫЙ переход (пропускаем повторный
		// тап той же кнопки: SetItemStatus идемпотентен, но не должен засорять
		// отчёт по времени нулевыми стадиями).
		if row.StationStatus == nil || *row.StationStatus != status {
			var changedBy *string
			if actor, ok := audit.ActorFromContext(ctx); ok && actor.UserID != "" {
				changedBy = &actor.UserID
			}
			ev := &models.OrderItemStageEvent{
				ID:           uuid.NewString(),
				OrderItemID:  itemID,
				RestaurantID: rid,
				MenuItemID:   row.MenuItemID,
				DishName:     row.Name,
				Station:      row.Station,
				FromStatus:   row.StationStatus,
				ToStatus:     status,
				ChangedBy:    changedBy,
				CreatedAt:    now,
			}
			if err := tx.Create(ev).Error; err != nil {
				return err
			}
		}
		name := ""
		if row.Name != nil {
			name = *row.Name
		}
		buf.Add(EventKDSItemUpdated, map[string]any{
			"id":             itemID,
			"order_id":       deref(row.OrderID),
			"station_status": status,
			"waiter_id":      deref(row.WaiterID),
			"order_number":   row.OrderNumber,
			"name":           name,
		})
		return nil
	})
	if err != nil {
		return nil, err
	}
	if s.pub != nil {
		s.pub.Flush(ctx, rid, buf)
	}

	// Возвращаем свежую карточку (единственная позиция по id).
	items, err := s.ListItems(ctx, nil, []string{"pending", "cooking", "ready", "served"})
	if err != nil {
		return nil, err
	}
	for i := range items {
		if items[i].ID == itemID {
			return &items[i], nil
		}
	}
	return &KDSItem{ID: itemID, StationStatus: status}, nil
}
