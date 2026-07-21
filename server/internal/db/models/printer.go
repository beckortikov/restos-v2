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
	ID           string  `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID string  `gorm:"column:restaurant_id;not null;index" json:"restaurant_id"`
	Name         string  `gorm:"not null" json:"name"`
	Kind         string  `gorm:"not null" json:"kind"` // receipt | station
	Station      *string `gorm:"column:station" json:"station"`
	Driver       string  `gorm:"not null" json:"driver"`
	Target       string  `gorm:"not null;default:''" json:"target"`
	Cols         int     `gorm:"not null;default:48" json:"cols"`
	// Codepage — номер таблицы символов (ESC t n), 055. 17 = PC866 по Epson.
	// Вынесен в настройку: часть принтеров держит кириллицу на другом индексе
	// и незнакомый номер игнорирует, оставаясь на CP437 — на чеке тогда вместо
	// русских букв греческие символы.
	Codepage  int  `gorm:"not null;default:17" json:"codepage"`
	IsDefault bool `gorm:"column:is_default;not null;default:false" json:"is_default"`
	Enabled   bool `gorm:"not null;default:true" json:"enabled"`
	// Content flags (миграция 015) — что печатать в receipt-чеке.
	// Для kind=station игнорируется (ранер всегда содержит позиции).
	PrintLogo       bool `gorm:"column:print_logo;not null;default:true" json:"print_logo"`
	PrintDiscount   bool `gorm:"column:print_discount;not null;default:true" json:"print_discount"`
	PrintService    bool `gorm:"column:print_service;not null;default:true" json:"print_service"`
	PrintTip        bool `gorm:"column:print_tip;not null;default:false" json:"print_tip"`
	PrintQRFeedback bool `gorm:"column:print_qr_feedback;not null;default:false" json:"print_qr_feedback"`
	// Stations — цехи, которые обслуживает станционный принтер (053,
	// printer_stations). Заполняется сервисом при чтении, в БД живёт в
	// join-таблице. Поле Station (legacy) хранит первую станцию списка.
	Stations  []string  `gorm:"-" json:"stations"`
	CreatedAt time.Time `gorm:"not null" json:"created_at"`
	UpdatedAt time.Time `gorm:"not null" json:"updated_at"`
}

func (Printer) TableName() string { return "printers" }

// PrinterStation — связка «принтер ↔ цех» (053). Один цех принадлежит максимум
// одному принтеру ресторана (unique restaurant_id+station). Все позиции цехов
// одного принтера печатаются одним бегунком (см. enqueueRunners).
type PrinterStation struct {
	PrinterID    string    `gorm:"column:printer_id;type:uuid;primaryKey" json:"printer_id"`
	Station      string    `gorm:"primaryKey" json:"station"`
	RestaurantID string    `gorm:"column:restaurant_id;not null;index" json:"restaurant_id"`
	CreatedAt    time.Time `gorm:"not null" json:"created_at"`
	UpdatedAt    time.Time `gorm:"not null" json:"updated_at"`
}

func (PrinterStation) TableName() string { return "printer_stations" }
