package models

import "time"

// SyncSettings — singleton-конфиг multi-branch sync, редактируемый из UI
// (ADR-003/004). Одна строка (id=1) на машину. Если строка есть — она
// перекрывает env RESTOS_SYNC_* и перечитывается пушером/пуллером на каждом
// тике (без перезапуска, кроме interval_sec); если строки нет — работает
// env-fallback (headless-узлы без UI-оператора).
type SyncSettings struct {
	ID           int        `gorm:"primaryKey;default:1" json:"-"`
	Enabled      bool       `json:"enabled"`
	CentralURL   *string    `gorm:"column:central_url" json:"central_url"`
	Token        *string    `json:"token"`
	RestaurantID *string    `gorm:"column:restaurant_id;type:uuid" json:"restaurant_id"`
	IntervalSec  int        `gorm:"column:interval_sec;default:30" json:"interval_sec"`
	UpdatedAt    *time.Time `gorm:"column:updated_at" json:"updated_at"`
	// BackfilledAt — маркер «история этого филиала отправлена на central»
	// (Ф6). NULL = ещё не выполнялся; main.go на старте сравнивает с Enabled,
	// чтобы отличить первое включение sync от обычного рестарта уже
	// синхронизирующейся кассы. Не трогается Update() (PUT /settings/sync
	// меняет только сетевые параметры) — выставляется ТОЛЬКО из Backfill().
	BackfilledAt *time.Time `gorm:"column:backfilled_at" json:"backfilled_at,omitempty"`
}

func (SyncSettings) TableName() string { return "sync_settings" }
