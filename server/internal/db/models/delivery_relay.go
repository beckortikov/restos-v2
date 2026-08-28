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
	// OrderType — hall|takeaway|delivery (092, CHECK в миграции). Central
	// диспетчерит не только доставку — материализованный на филиале заказ
	// должен попасть в ту же секцию кассы, что и обычный заказ этого типа.
	OrderType string `gorm:"column:order_type;default:delivery" json:"order_type"`
	// Kind — create|amend (094, CHECK в миграции). amend — «дозаказ» в уже
	// материализованный заказ (родительская create-строка в status=delivered):
	// филиал не создаёт новый Order, а добавляет позиции в существующий через
	// тот же OrdersService.AddItems, которым официант дозаказывает вживую.
	Kind string `gorm:"column:kind;default:create" json:"kind"`
	// ParentRelayID — только у kind=amend: id исходной create-строки. Филиал
	// находит её местный заказ через DeliveryRelayReceived (relay_order_id =
	// ParentRelayID → local_order_id) — не через LocalOrderID ЭТОЙ строки,
	// у amend-строки своего заказа нет, она дополняет чужой.
	ParentRelayID *string `gorm:"column:parent_relay_id;type:uuid" json:"parent_relay_id,omitempty"`
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
	// VariantLabels — комбинация значений атрибутов («Стандарт», ["1 л",
	// "Виноград"]), если позиция — вариант товара с атрибутами (092). Сеть НЕ
	// хранит id вариантов (084, network_menu_items.attributes — снэпшот без
	// id: "id атрибутов/значений/шкал локальны для каждого узла") — то есть
	// сами лейблы, в порядке атрибутов продукта, единственный портируемый
	// идентификатор комбинации между central и филиалом. Пусто → позиция
	// сама по себе, без атрибутов (как раньше).
	VariantLabels []string `json:"variant_labels,omitempty"`
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
