package service

import (
	"context"
	"errors"
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/cursor"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
	apperrors "github.com/restos/restos-v4/server/internal/pkg/errors"
	"github.com/restos/restos-v4/server/internal/pkg/tenant"
	"github.com/restos/restos-v4/server/internal/repo"
)

type OrdersService struct {
	r        *repo.Repo
	pub      *EventPublisher // опционально; nil → события не публикуются (тесты)
	stations StationResolver // опционально; nil → runner-jobs без printer_id
}

func NewOrdersService(r *repo.Repo) *OrdersService {
	return &OrdersService{r: r}
}

// WithPublisher оборачивает сервис с EventPublisher.
// Используется в router после wiring'а hub.
func (s *OrdersService) WithPublisher(pub *EventPublisher) *OrdersService {
	s.pub = pub
	return s
}

// publish — внутренний helper. Если pub nil — no-op.
func (s *OrdersService) publish(ctx context.Context, restaurantID string, buf *EventBuffer) {
	if s.pub == nil {
		return
	}
	s.pub.Flush(ctx, restaurantID, buf)
}

// OrdersFilter — фильтры для GET /orders.
type OrdersFilter struct {
	Status  string
	TableID string
	ShiftID string
	From    *time.Time // created_at >=
	To      *time.Time // created_at <
	Page    cursor.Page
}

// OrderSlim — компактный DTO для списка. Без items/modifiers — это «карточка»
// заказа в KDS/истории. Цель: быстро отдать 10k заказов с p99 < 50мс.
//
// Поля выбираем явным SELECT — это снижает payload и I/O.
type OrderSlim struct {
	ID           string          `json:"id"`
	OrderNumber  int             `json:"order_number"`
	Status       *string         `json:"status,omitempty"`
	Type         *string         `json:"type,omitempty"`
	TableID      *string         `json:"table_id,omitempty"`
	WaiterID     *string         `json:"waiter_id,omitempty"`
	GuestsCount  *int            `json:"guests_count,omitempty"`
	Total        decimal.Decimal `json:"total"`
	TotalWithSvc decimal.Decimal `json:"total_with_service"`
	ShiftID      *string         `json:"shift_id,omitempty"`
	CreatedAt    time.Time       `json:"created_at"`
	ClosedAt     *time.Time      `json:"closed_at,omitempty"`
}

// orderSlimRow — внутреннее: GORM-биндинг (имена колонок).
type orderSlimRow struct {
	ID               string          `gorm:"column:id"`
	OrderNumber      int             `gorm:"column:order_number"`
	Status           *string         `gorm:"column:status"`
	Type             *string         `gorm:"column:type"`
	TableID          *string         `gorm:"column:table_id"`
	WaiterID         *string         `gorm:"column:waiter_id"`
	GuestsCount      *int            `gorm:"column:guests_count"`
	Total            decimal.Decimal `gorm:"column:total"`
	TotalWithService decimal.Decimal `gorm:"column:total_with_service"`
	ShiftID          *string         `gorm:"column:shift_id"`
	CreatedAt        time.Time       `gorm:"column:created_at"`
	ClosedAt         *time.Time      `gorm:"column:closed_at"`
}

const slimSelect = `id, order_number, status, "type", table_id, waiter_id, guests_count,
total, total_with_service, shift_id, created_at, closed_at`

// List — постраничный slim-список. Использует индекс
// idx_orders_restaurant_created (PRD 05) → keyset быстрый.
func (s *OrdersService) List(ctx context.Context, f OrdersFilter) ([]OrderSlim, string, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, "", err
	}
	q := scoped.Table("orders").Select(slimSelect)
	if f.Status != "" {
		q = q.Where("status = ?", f.Status)
	}
	if f.TableID != "" {
		q = q.Where("table_id = ?", f.TableID)
	}
	if f.ShiftID != "" {
		q = q.Where("shift_id = ?", f.ShiftID)
	}
	if f.From != nil {
		q = q.Where("created_at >= ?", *f.From)
	}
	if f.To != nil {
		q = q.Where("created_at < ?", *f.To)
	}
	q = cursor.Apply(q, "orders", f.Page)

	var rows []orderSlimRow
	if err := q.Scan(&rows).Error; err != nil {
		return nil, "", err
	}
	out := make([]OrderSlim, 0, len(rows))
	for _, r := range rows {
		out = append(out, OrderSlim{
			ID:           r.ID,
			OrderNumber:  r.OrderNumber,
			Status:       r.Status,
			Type:         r.Type,
			TableID:      r.TableID,
			WaiterID:     r.WaiterID,
			GuestsCount:  r.GuestsCount,
			Total:        r.Total,
			TotalWithSvc: r.TotalWithService,
			ShiftID:      r.ShiftID,
			CreatedAt:    r.CreatedAt,
			ClosedAt:     r.ClosedAt,
		})
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(out, limit, func(m OrderSlim) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

// OrderDetail — заказ со всеми relation'ами (items + modifiers + voids).
type OrderDetail struct {
	Order models.Order             `json:"order"`
	Items []orderItemWithModifiers `json:"items"`
	Voids []models.OrderVoid       `json:"voids"`
}

type orderItemWithModifiers struct {
	models.OrderItem
	Modifiers []models.OrderItemModifier `json:"modifiers,omitempty"`
}

// Get — детальный заказ. Делает 3 запроса (order + items + voids) и
// группирует модификаторы по items в Go — это дешевле, чем join+denorm.
//
// Bottleneck большинства POS-API — N+1 по items. Тут мы избегаем.
func (s *OrdersService) Get(ctx context.Context, id string) (*OrderDetail, error) {
	scoped, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var order models.Order
	if err := scoped.First(&order, "id = ?", id).Error; err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}

	// order_items не имеет restaurant_id — изоляция через order.id (он уже
	// прошёл ForTenant). Raw() допустим — мы знаем, что заказ из нашего tenant.
	// Session{NewDB:true} перед каждой выборкой — иначе chain-state из First
	// затекает в следующие Where и портит SQL.
	freshRaw := func() *gorm.DB {
		return s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	}
	var items []models.OrderItem
	if err := freshRaw().Where("order_id = ?", id).
		Order("created_at ASC").
		Find(&items).Error; err != nil {
		return nil, err
	}

	itemIDs := make([]string, 0, len(items))
	for _, it := range items {
		itemIDs = append(itemIDs, it.ID)
	}

	var mods []models.OrderItemModifier
	if len(itemIDs) > 0 {
		if err := freshRaw().Where("order_item_id IN ?", itemIDs).
			Find(&mods).Error; err != nil {
			return nil, err
		}
	}
	modsByItem := make(map[string][]models.OrderItemModifier, len(items))
	for _, m := range mods {
		if m.OrderItemID == nil {
			continue
		}
		modsByItem[*m.OrderItemID] = append(modsByItem[*m.OrderItemID], m)
	}

	itemsOut := make([]orderItemWithModifiers, 0, len(items))
	for _, it := range items {
		itemsOut = append(itemsOut, orderItemWithModifiers{
			OrderItem: it,
			Modifiers: modsByItem[it.ID],
		})
	}

	// Свежий tenant-scope: предыдущий `scoped` уже несёт chain-state от
	// .First(orders) (id=?, ORDER BY id, LIMIT 1). Реюз приводит к корявому SQL.
	voidScope, err := s.r.ForTenant(ctx)
	if err != nil {
		return nil, err
	}
	var voids []models.OrderVoid
	if err := voidScope.Where("order_id = ?", id).
		Order("created_at ASC").
		Find(&voids).Error; err != nil {
		return nil, err
	}

	return &OrderDetail{Order: order, Items: itemsOut, Voids: voids}, nil
}

// GetByID — точечный lookup позиции по item.id. order_items не имеет
// restaurant_id, поэтому tenant-изоляция через JOIN на parent order.
//
// Используется фронтом для resolve order_id по item_id (см. _findOrderIdForItem).
// 404 если item не существует или принадлежит другому tenant'у.
func (s *OrdersService) GetByID(ctx context.Context, id string) (*models.OrderItem, error) {
	rid, err := tenant.MustRestaurantID(ctx)
	if err != nil {
		return nil, err
	}
	// Используем raw gorm.DB с явным JOIN — у order_items нет restaurant_id,
	// поэтому стандартный ForTenant не подходит. Tenant-проверка через o.restaurant_id.
	db := s.r.DB().Session(&gorm.Session{NewDB: true}).WithContext(ctx)
	var item models.OrderItem
	err = db.Table("order_items AS oi").
		Select("oi.*").
		Joins("JOIN orders o ON o.id = oi.order_id").
		Where("oi.id = ? AND o.restaurant_id = ?", id, rid).
		First(&item).Error
	if err != nil {
		if errors.Is(err, gorm.ErrRecordNotFound) {
			return nil, apperrors.ErrNotFound
		}
		return nil, err
	}
	return &item, nil
}
