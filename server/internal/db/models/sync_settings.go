package models

import "time"

// SyncSettings — singleton-конфиг multi-branch sync, редактируемый из UI
// (ADR-003/004). Одна строка (id=1) на машину. Сервер читает при старте
// (перекрывает env RESTOS_SYNC_*), применяется после перезапуска.
type SyncSettings struct {
	ID           int        `gorm:"primaryKey;default:1" json:"-"`
	Enabled      bool       `json:"enabled"`
	CentralURL   *string    `gorm:"column:central_url" json:"central_url"`
	Token        *string    `json:"token"`
	RestaurantID *string    `gorm:"column:restaurant_id;type:uuid" json:"restaurant_id"`
	IntervalSec  int        `gorm:"column:interval_sec;default:30" json:"interval_sec"`
	UpdatedAt    *time.Time `gorm:"column:updated_at" json:"updated_at"`
}

func (SyncSettings) TableName() string { return "sync_settings" }
