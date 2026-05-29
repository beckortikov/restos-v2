package models

import (
	"time"

	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Order — заказ.
// ВАЖНО: status, type — TEXT в БД, без enum-CHECK на уровне миграции 001
// (мы дублируем legacy-схему). Валидация значений — в сервисном слое +
// добавим CHECK-constraints в отдельной миграции после Phase 1.
type Order struct {
	ID                 string           `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	OrderNumber        int              `gorm:"column:order_number" json:"order_number"` // per-restaurant per-day, сервис проставляет атомарно в Create через order_counters
	Status             *string          `gorm:"default:'new';index" json:"status"`
	Type               *string          `gorm:"default:'hall'" json:"type"`
	TableID            *string          `gorm:"column:table_id" json:"table_id"`
	WaiterID           *string          `gorm:"column:waiter_id" json:"waiter_id"`
	CashierID          *string          `gorm:"column:cashier_id" json:"cashier_id"`
	CustomerID         *string          `gorm:"column:customer_id" json:"customer_id"`
	PaymentMethod      *string          `gorm:"column:payment_method" json:"payment_method"`
	Comment            *string          `json:"comment"`
	Total              decimal.Decimal  `gorm:"type:numeric(14,4);default:0" json:"total"`
	ServicePercent     decimal.Decimal  `gorm:"column:service_percent;type:numeric(14,4);default:0" json:"service_percent"`
	ServiceAmount      decimal.Decimal  `gorm:"column:service_amount;type:numeric(14,4);default:0" json:"service_amount"`
	TotalWithService   decimal.Decimal  `gorm:"column:total_with_service;type:numeric(14,4);default:0" json:"total_with_service"`
	GuestsCount        *int             `gorm:"column:guests_count;default:1" json:"guests_count"`
	TipAmount          decimal.Decimal  `gorm:"column:tip_amount;type:numeric(14,4);default:0" json:"tip_amount"`
	Payments           datatypes.JSON   `gorm:"type:jsonb;default:'[]'" json:"payments"`
	DiscountType       *string          `gorm:"column:discount_type" json:"discount_type"`
	DiscountValue      decimal.Decimal  `gorm:"column:discount_value;type:numeric(14,4);default:0" json:"discount_value"`
	DiscountAmount     decimal.Decimal  `gorm:"column:discount_amount;type:numeric(14,4);default:0" json:"discount_amount"`
	DiscountReason     *string          `gorm:"column:discount_reason" json:"discount_reason"`
	DiscountApprovedBy *string          `gorm:"column:discount_approved_by" json:"discount_approved_by"`
	IsSplit            *bool            `gorm:"column:is_split;default:false" json:"is_split"`
	SplitCount         *int             `gorm:"column:split_count;default:0" json:"split_count"`
	ShiftID            *string          `gorm:"column:shift_id;index" json:"shift_id"`
	RestaurantID       *string          `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	KitchenStartedAt   *time.Time       `gorm:"column:kitchen_started_at" json:"kitchen_started_at"`
	ReadyAt            *time.Time       `gorm:"column:ready_at" json:"ready_at"`
	ExpectedReadyAt    *time.Time       `gorm:"column:expected_ready_at" json:"expected_ready_at"`
	ClosedAt           *time.Time       `gorm:"column:closed_at" json:"closed_at"`
	CancelledAt        *time.Time       `gorm:"column:cancelled_at" json:"cancelled_at"`
	CancelledBy        *string          `gorm:"column:cancelled_by" json:"cancelled_by"`
	CancelReason       *string          `gorm:"column:cancel_reason" json:"cancel_reason"`
	CancelledTotal     *decimal.Decimal `gorm:"column:cancelled_total;type:numeric(14,4)" json:"cancelled_total"`
	CreatedAt          time.Time        `json:"created_at"`
	UpdatedAt          time.Time        `json:"updated_at"`
}

func (Order) TableName() string { return "orders" }

// OrderItem — позиция в заказе.
type OrderItem struct {
	ID                   string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	OrderID              *string         `gorm:"column:order_id;type:uuid;index" json:"order_id"`
	MenuItemID           *string         `gorm:"column:menu_item_id;type:uuid" json:"menu_item_id"`
	Name                 *string         `json:"name"`
	Qty                  decimal.Decimal `gorm:"type:numeric(14,4);default:1" json:"qty"`
	Price                decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"price"`
	COGS                 decimal.Decimal `gorm:"column:cogs;type:numeric(14,4);default:0" json:"cogs"`
	Unit                 *string         `gorm:"default:'piece'" json:"unit"`
	UnitSize             decimal.Decimal `gorm:"column:unit_size;type:numeric(14,4);default:1" json:"unit_size"`
	CancelledAt          *time.Time      `gorm:"column:cancelled_at" json:"cancelled_at"`
	CancelledBy          *string         `gorm:"column:cancelled_by" json:"cancelled_by"`
	CancelReason         *string         `gorm:"column:cancel_reason" json:"cancel_reason"`
	PrintedAt            *time.Time      `gorm:"column:printed_at" json:"printed_at"`
	CancelPrintedAt      *time.Time      `gorm:"column:cancel_printed_at" json:"cancel_printed_at"`
	ServedAt             *time.Time      `gorm:"column:served_at" json:"served_at"`
	PrintClaimedAt       *time.Time      `gorm:"column:print_claimed_at" json:"print_claimed_at"`
	PrintClaimedBy       *string         `gorm:"column:print_claimed_by" json:"print_claimed_by"`
	CancelPrintClaimedAt *time.Time      `gorm:"column:cancel_print_claimed_at" json:"cancel_print_claimed_at"`
	CancelPrintClaimedBy *string         `gorm:"column:cancel_print_claimed_by" json:"cancel_print_claimed_by"`
	CreatedAt            time.Time       `json:"created_at"`
	UpdatedAt            time.Time       `json:"updated_at"`
}

func (OrderItem) TableName() string { return "order_items" }

// OrderItemModifier — выбранный модификатор позиции.
type OrderItemModifier struct {
	ID          string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	OrderItemID *string         `gorm:"column:order_item_id;type:uuid;index" json:"order_item_id"`
	ModifierID  *string         `gorm:"column:modifier_id;type:uuid" json:"modifier_id"`
	Name        *string         `json:"name"`
	Price       decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"price"`
	UpdatedAt   time.Time       `json:"updated_at"`
}

func (OrderItemModifier) TableName() string { return "order_item_modifiers" }

// OrderVoid — событие отмены позиции (audit-friendly).
type OrderVoid struct {
	ID             string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	OrderID        *string         `gorm:"column:order_id;type:uuid;index" json:"order_id"`
	ItemName       *string         `gorm:"column:item_name" json:"item_name"`
	ItemQty        *int            `gorm:"column:item_qty;default:1" json:"item_qty"`
	ItemPrice      decimal.Decimal `gorm:"column:item_price;type:numeric(14,4);default:0" json:"item_price"`
	Reason         *string         `json:"reason"`
	ApprovedBy     *string         `gorm:"column:approved_by" json:"approved_by"`
	ApprovedByName *string         `gorm:"column:approved_by_name" json:"approved_by_name"`
	CreatedBy      *string         `gorm:"column:created_by" json:"created_by"`
	CreatedByName  *string         `gorm:"column:created_by_name" json:"created_by_name"`
	RestaurantID   *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt      time.Time       `json:"created_at"`
}

func (OrderVoid) TableName() string { return "order_voids" }

// OrderSplit — разбиение счёта.
type OrderSplit struct {
	ID             string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	OrderID        *string         `gorm:"column:order_id;type:uuid;index" json:"order_id"`
	SplitNumber    *int            `gorm:"column:split_number" json:"split_number"`
	SplitType      *string         `gorm:"column:split_type;default:'equal'" json:"split_type"`
	Items          datatypes.JSON  `gorm:"type:jsonb" json:"items"`
	Subtotal       decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"subtotal"`
	ServicePercent decimal.Decimal `gorm:"column:service_percent;type:numeric(14,4);default:0" json:"service_percent"`
	ServiceAmount  decimal.Decimal `gorm:"column:service_amount;type:numeric(14,4);default:0" json:"service_amount"`
	Total          decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"total"`
	Status         *string         `gorm:"default:'pending'" json:"status"`
	PaymentMethod  *string         `gorm:"column:payment_method" json:"payment_method"`
	AccountID      *string         `gorm:"column:account_id" json:"account_id"`
	AccountName    *string         `gorm:"column:account_name" json:"account_name"`
	PaidAt         *time.Time      `gorm:"column:paid_at" json:"paid_at"`
	PaidBy         *string         `gorm:"column:paid_by" json:"paid_by"`
	RestaurantID   *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt      time.Time       `json:"created_at"`
}

func (OrderSplit) TableName() string { return "order_splits" }
