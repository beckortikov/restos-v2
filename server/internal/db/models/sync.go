package models

import (
	"time"

	"gorm.io/datatypes"
)

// SyncLog — журнал дельт для синхронизации филиал → центральный узел
// (Фаза 2 multi-branch, ADR-003). Append-only; synced_at NULL = не отправлено.
type SyncLog struct {
	ID           string         `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Entity       string         `gorm:"column:table_name;not null" json:"table_name"`
	RowID        string         `gorm:"column:row_id;not null" json:"row_id"`
	Op           string         `gorm:"not null" json:"op"` // insert | update | delete
	RestaurantID *string        `gorm:"column:restaurant_id;type:uuid" json:"restaurant_id"`
	AccountID    *string        `gorm:"column:account_id;type:uuid;index" json:"account_id"`
	Payload      datatypes.JSON `gorm:"type:jsonb" json:"payload"`
	CreatedAt    time.Time      `json:"created_at"`
	SyncedAt     *time.Time     `gorm:"column:synced_at" json:"synced_at"`
	// Attempts/FailedAt/LastError — карантин ядовитых строк (Фаза О, миграция
	// 078). FailedAt != NULL → строка исключена из выборки пушера, очередь идёт
	// дальше без неё; сама строка остаётся в журнале с причиной в LastError.
	Attempts  int        `gorm:"column:attempts;default:0" json:"attempts"`
	FailedAt  *time.Time `gorm:"column:failed_at" json:"failed_at,omitempty"`
	LastError *string    `gorm:"column:last_error" json:"last_error,omitempty"`
}

func (SyncLog) TableName() string { return "sync_log" }
