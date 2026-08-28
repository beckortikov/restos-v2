package models

import (
	"time"

	"gorm.io/datatypes"
)

// DeliveryRelayOrder — заказ доставки, пробитый на central ЗА филиал (см.
// миграцию 091). Это НЕ заказ сам по себе, а транспорт для его передачи —
// узкая очередь между central и конкретным филиалом, отдельная от общего
// sync_log/sync_queue (тот синкает только вверх и только терминальные
// заказы, ADR-003). Филиал забирает pending-строки быстрым poll'ом
// (DeliveryPuller) и материализует настоящий Order через обычный
// orders.Service.Create.
type DeliveryRelayOrder struct {
	ID                 string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AccountID          string `gorm:"column:account_id;type:uuid" json:"account_id"`
	RestaurantID       string `gorm:"column:restaurant_id;type:uuid" json:"restaurant_id"`
	TargetRestaurantID string `gorm:"column:target_restaurant_id;type:uuid;index" json:"target_restaurant_id"`
	// Items — []DeliveryRelayItem, network_menu_item_id (не локальный
	// menu_items.id — у central и филиала разные локальные id одного блюда).
	Items           datatypes.JSON `gorm:"type:jsonb" json:"items"`
	DeliveryPhone   *string        `gorm:"column:delivery_phone" json:"delivery_phone,omitempty"`
	DeliveryAddress *string        `gorm:"column:delivery_address" json:"delivery_address,omitempty"`
	Comment         *string        `json:"comment,omitempty"`
	// Status — pending|delivered|failed (CHECK в миграции).
	Status       string     `json:"status"`
	LocalOrderID *string    `gorm:"column:local_order_id;type:uuid" json:"local_order_id,omitempty"`
	Error        *string    `json:"error,omitempty"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
	DeliveredAt  *time.Time `gorm:"column:delivered_at" json:"delivered_at,omitempty"`
}

func (DeliveryRelayOrder) TableName() string { return "delivery_relay_orders" }

// DeliveryRelayItem — одна позиция внутри DeliveryRelayOrder.Items (JSONB).
type DeliveryRelayItem struct {
	NetworkMenuItemID string `json:"network_menu_item_id"`
	Qty               string `json:"qty"`
}

// DeliveryRelayReceived — идемпотентность НА ФИЛИАЛЕ (см. миграцию 091):
// какие relay_order_id уже материализованы в локальный Order, чтобы обрыв
// сети между Create() и ack к central не создал дубль заказа на следующем
// тике DeliveryPuller.
type DeliveryRelayReceived struct {
	RelayOrderID string    `gorm:"column:relay_order_id;primaryKey;type:uuid" json:"relay_order_id"`
	LocalOrderID string    `gorm:"column:local_order_id;type:uuid" json:"local_order_id"`
	CreatedAt    time.Time `json:"created_at"`
}

func (DeliveryRelayReceived) TableName() string { return "delivery_relay_received" }
