package models

import "time"

// Zone — зона в зале (например «Терраса», «Зал 1»).
type Zone struct {
	ID           string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         string `gorm:"not null" json:"name"`
	Description  *string `json:"description"`
	SortOrder    *int `gorm:"column:sort_order;default:0" json:"sort_order"`
	RestaurantID *string `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (Zone) TableName() string { return "zones" }

// Table — стол. status: free/occupied/reserved/dirty.
type Table struct {
	ID               string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Number           *int `json:"number"`
	Name             *string `json:"name"`
	Capacity         *int `gorm:"default:4" json:"capacity"`
	ZoneID           *string `gorm:"column:zone_id" json:"zone_id"`
	Status           *string `gorm:"default:'free'" json:"status"`
	CurrentOrderID   *string `gorm:"column:current_order_id" json:"current_order_id"`
	WaiterID         *string `gorm:"column:waiter_id" json:"waiter_id"`
	OpenedAt         *time.Time `gorm:"column:opened_at" json:"opened_at"`
	MergedWith       *string `gorm:"column:merged_with" json:"merged_with"`
	OriginalCapacity *int `gorm:"column:original_capacity" json:"original_capacity"`
	RestaurantID     *string `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

func (Table) TableName() string { return "tables" }

// Reservation — бронь.
type Reservation struct {
	ID           string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	TableID      *string `gorm:"column:table_id" json:"table_id"`
	GuestName    *string `gorm:"column:guest_name" json:"guest_name"`
	GuestPhone   *string `gorm:"column:guest_phone" json:"guest_phone"`
	GuestsCount  *int `gorm:"column:guests_count;default:2" json:"guests_count"`
	ReservedAt   *time.Time `gorm:"column:reserved_at" json:"reserved_at"`
	DurationMin  *int `gorm:"column:duration_min;default:120" json:"duration_min"`
	Status       *string `gorm:"default:'pending'" json:"status"`
	Note         *string `json:"note"`
	CreatedBy    *string `gorm:"column:created_by" json:"created_by"`
	RestaurantID *string `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
}

func (Reservation) TableName() string { return "reservations" }
