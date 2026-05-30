package service

import (
	"context"
	"errors"
	"strconv"
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
	Status   string
	TableID  string
	ShiftID  string
	WaiterID string // filter by orders.waiter_id (для «Мои заказы» в Kotlin APK)
	From     *time.Time // created_at >=
	To       *time.Time // created_at <
	Page     cursor.Page
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
	// Enriched display-only fields (батч-загрузка в List, чтобы избежать N+1 на клиенте).
	TableName  string `json:"table_name,omitempty"`
	WaiterName string `json:"waiter_name,omitempty"`
	ZoneName   string `json:"zone_name,omitempty"`
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
	if f.WaiterID != "" {
		q = q.Where("waiter_id = ?", f.WaiterID)
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
	// Enrich display-only поля (table_name, waiter_name, zone_name) батч-запросами.
	// 2–3 запроса на список вместо N+1 lookups на клиенте.
	if err := s.enrichSlim(ctx, out); err != nil {
		return nil, "", err
	}
	limit := cursor.NormalizeLimit(f.Page.Limit)
	trimmed, next := cursor.Next(out, limit, func(m OrderSlim) cursor.Token {
		return cursor.Token{Time: m.CreatedAt, ID: m.ID}
	})
	return trimmed, next, nil
}

// OrderDetail — заказ со всеми relation'ами (items + modifiers + voids).
//
// `Order` сериализуется через orderWithComputed — добавляет computed `subtotal`
// (сумма по неотменённым позициям), не меняя БД-схему.
type OrderDetail struct {
	Order orderWithComputed        `json:"order"`
	Items []orderItemWithModifiers `json:"items"`
	Voids []models.OrderVoid       `json:"voids"`
}

// orderWithComputed — JSON-only обёртка над models.Order с computed-полями.
// Поля БД остаются как есть, добавляется только `subtotal` для UI.
type orderWithComputed struct {
	models.Order
	Subtotal decimal.Decimal `json:"subtotal"`
}

type orderItemWithModifiers struct {
	models.OrderItem
	Modifiers []models.OrderItemModifier `json:"modifiers,omitempty"`
	// KitchenStatus — computed per-item: pending/cooking/ready/served/cancelled.
	// Вычисляется из флагов order + item; колонки в БД нет.
	KitchenStatus string `json:"kitchen_status"`
}

// computeItemKitchenStatus возвращает per-item статус для UI.
//
//	served    — item.served_at != nil
//	cancelled — item.cancelled_at != nil
//	ready     — order.ready_at != nil И !item.served_at
//	cooking   — order.kitchen_started_at != nil И !item.served_at
//	pending   — иначе
func computeItemKitchenStatus(o *models.Order, it *models.OrderItem) string {
	if it.CancelledAt != nil {
		return "cancelled"
	}
	if it.ServedAt != nil {
		return "served"
	}
	if o.ReadyAt != nil {
		return "ready"
	}
	if o.KitchenStartedAt != nil {
		return "cooking"
	}
	return "pending"
}

// computeSubtotal — сумма qty*price по неотменённым позициям.
func computeSubtotal(items []models.OrderItem) decimal.Decimal {
	sum := decimal.Zero
	for _, it := range items {
		if it.CancelledAt != nil {
			continue
		}
		sum = decimal.Add(sum, decimal.Mul(it.Qty, it.Price))
	}
	return sum
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
			OrderItem:     it,
			Modifiers:     modsByItem[it.ID],
			KitchenStatus: computeItemKitchenStatus(&order, &it),
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

	return &OrderDetail{
		Order: orderWithComputed{Order: order, Subtotal: computeSubtotal(items)},
		Items: itemsOut,
		Voids: voids,
	}, nil
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

// enrichSlim — батч-обогащение OrderSlim display-полями (table_name, waiter_name, zone_name).
// Делает максимум 3 SQL запроса (tables, users, zones), tenant-scoped.
// Mutates rows in-place.
func (s *OrdersService) enrichSlim(ctx context.Context, rows []OrderSlim) error {
	if len(rows) == 0 {
		return nil
	}
	tableSet := make(map[string]struct{})
	waiterSet := make(map[string]struct{})
	for _, r := range rows {
		if r.TableID != nil && *r.TableID != "" {
			tableSet[*r.TableID] = struct{}{}
		}
		if r.WaiterID != nil && *r.WaiterID != "" {
			waiterSet[*r.WaiterID] = struct{}{}
		}
	}
	type tinyTable struct {
		ID     string  `gorm:"column:id"`
		Number *int    `gorm:"column:number"`
		Name   *string `gorm:"column:name"`
		ZoneID *string `gorm:"column:zone_id"`
	}
	type tinyUser struct {
		ID   string  `gorm:"column:id"`
		Name *string `gorm:"column:name"`
	}
	type tinyZone struct {
		ID   string `gorm:"column:id"`
		Name string `gorm:"column:name"`
	}

	tableNameByID := make(map[string]string, len(tableSet))
	zoneIDByTableID := make(map[string]string, len(tableSet))
	if len(tableSet) > 0 {
		ids := make([]string, 0, len(tableSet))
		for id := range tableSet {
			ids = append(ids, id)
		}
		scoped, err := s.r.ForTenant(ctx)
		if err != nil {
			return err
		}
		var ts []tinyTable
		if err := scoped.Table("tables").
			Select("id, number, name, zone_id").
			Where("id IN ?", ids).
			Scan(&ts).Error; err != nil {
			return err
		}
		for _, t := range ts {
			name := ""
			if t.Name != nil && *t.Name != "" {
				name = *t.Name
			} else if t.Number != nil {
				name = "№" + strconv.Itoa(*t.Number)
			}
			tableNameByID[t.ID] = name
			if t.ZoneID != nil && *t.ZoneID != "" {
				zoneIDByTableID[t.ID] = *t.ZoneID
			}
		}
	}

	waiterNameByID := make(map[string]string, len(waiterSet))
	if len(waiterSet) > 0 {
		ids := make([]string, 0, len(waiterSet))
		for id := range waiterSet {
			ids = append(ids, id)
		}
		scoped, err := s.r.ForTenant(ctx)
		if err != nil {
			return err
		}
		var us []tinyUser
		if err := scoped.Table("users").
			Select("id, name").
			Where("id IN ?", ids).
			Scan(&us).Error; err != nil {
			return err
		}
		for _, u := range us {
			if u.Name != nil {
				waiterNameByID[u.ID] = *u.Name
			}
		}
	}

	zoneNameByID := make(map[string]string)
	if len(zoneIDByTableID) > 0 {
		zset := make(map[string]struct{}, len(zoneIDByTableID))
		for _, z := range zoneIDByTableID {
			zset[z] = struct{}{}
		}
		ids := make([]string, 0, len(zset))
		for id := range zset {
			ids = append(ids, id)
		}
		scoped, err := s.r.ForTenant(ctx)
		if err != nil {
			return err
		}
		var zs []tinyZone
		if err := scoped.Table("zones").
			Select("id, name").
			Where("id IN ?", ids).
			Scan(&zs).Error; err != nil {
			return err
		}
		for _, z := range zs {
			zoneNameByID[z.ID] = z.Name
		}
	}

	for i := range rows {
		if rows[i].TableID != nil {
			if n, ok := tableNameByID[*rows[i].TableID]; ok {
				rows[i].TableName = n
			}
			if zid, ok := zoneIDByTableID[*rows[i].TableID]; ok {
				if zn, ok := zoneNameByID[zid]; ok {
					rows[i].ZoneName = zn
				}
			}
		}
		if rows[i].WaiterID != nil {
			if n, ok := waiterNameByID[*rows[i].WaiterID]; ok {
				rows[i].WaiterName = n
			}
		}
	}
	return nil
}

