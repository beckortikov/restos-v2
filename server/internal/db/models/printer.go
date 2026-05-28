package models

import "time"

// Printer — настройка физического/виртуального принтера для печати чеков и
// ранеров (см. миграцию 004).
//
// kind:
//   - receipt: печатает фискальные чеки клиенту (close_order).
//   - station: печатает ранеры повару (один на цех — горячий/холодный/бар).
//     В этом случае поле Station обязательно (например "hot_kitchen").
//
// driver: tcp | usb | virtual | mock.
// target: connection string per-driver (см. миграцию).
type Printer struct {
	ID           string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID string `gorm:"column:restaurant_id;not null;index" json:"restaurant_id"`
	Name         string `gorm:"not null" json:"name"`
	Kind         string `gorm:"not null" json:"kind"` // receipt | station
	Station      *string `gorm:"column:station" json:"station"`
	Driver       string `gorm:"not null" json:"driver"`
	Target       string `gorm:"not null;default:''" json:"target"`
	Cols         int `gorm:"not null;default:48" json:"cols"`
	IsDefault    bool `gorm:"column:is_default;not null;default:false" json:"is_default"`
	Enabled      bool `gorm:"not null;default:true" json:"enabled"`
	CreatedAt    time.Time `gorm:"not null" json:"created_at"`
	UpdatedAt    time.Time `gorm:"not null" json:"updated_at"`
}

func (Printer) TableName() string { return "printers" }
