package models

import (
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Customer — клиент (для CRM/программ лояльности).
type Customer struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         *string         `json:"name"`
	Phone        *string         `json:"phone"`
	Email        *string         `json:"email"`
	BirthDate    *string         `gorm:"column:birth_date" json:"birth_date"`
	Notes        *string         `json:"notes"`
	VisitsCount  *int            `gorm:"column:visits_count;default:0" json:"visits_count"`
	TotalSpent   decimal.Decimal `gorm:"column:total_spent;type:numeric(14,4);default:0" json:"total_spent"`
	AvgCheck     decimal.Decimal `gorm:"column:avg_check;type:numeric(14,4);default:0" json:"avg_check"`
	LastVisitAt  *time.Time      `gorm:"column:last_visit_at" json:"last_visit_at"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
}

func (Customer) TableName() string { return "customers" }

// TimeEntry — учёт рабочего времени (clock_in/out).
type TimeEntry struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	UserID       *string         `gorm:"column:user_id;type:uuid" json:"user_id"`
	ClockIn      *time.Time      `gorm:"column:clock_in" json:"clock_in"`
	ClockOut     *time.Time      `gorm:"column:clock_out" json:"clock_out"`
	BreakMinutes *int            `gorm:"column:break_minutes;default:0" json:"break_minutes"`
	TotalHours   decimal.Decimal `gorm:"column:total_hours;type:numeric(14,4);default:0" json:"total_hours"`
	Status       *string         `gorm:"default:'active'" json:"status"`
	Note         *string         `json:"note"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
}

func (TimeEntry) TableName() string { return "time_entries" }

// IdempotencyKey — кэш ответов для Idempotency-Key middleware.
//
// response_body — bytea, а не jsonb (см. миграцию 003): jsonb пересортирует
// ключи при roundtrip, что ломает байт-точный replay.
type IdempotencyKey struct {
	Key            string    `gorm:"primaryKey;type:uuid" json:"key"`
	Method         string    `gorm:"not null" json:"method"`
	Path           string    `gorm:"not null" json:"path"`
	RequestHash    string    `gorm:"column:request_hash;not null" json:"request_hash"`
	ResponseStatus int       `gorm:"column:response_status;not null" json:"response_status"`
	ResponseBody   []byte    `gorm:"column:response_body;type:bytea" json:"response_body"`
	RestaurantID   *string   `gorm:"column:restaurant_id" json:"restaurant_id"`
	UserID         *string   `gorm:"column:user_id" json:"user_id"`
	CreatedAt      time.Time `gorm:"not null" json:"created_at"`
	ExpiresAt      time.Time `gorm:"column:expires_at;not null;index" json:"expires_at"`
}

func (IdempotencyKey) TableName() string { return "idempotency_keys" }

// PrintJob — задача в очереди печати.
// status: pending | running | done | failed.
type PrintJob struct {
	ID           string     `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Type         string     `gorm:"not null" json:"type"`
	PrinterID    *string    `gorm:"column:printer_id" json:"printer_id"`
	Payload      []byte     `gorm:"type:bytea;not null" json:"payload"`
	OrderID      *string    `gorm:"column:order_id;type:uuid" json:"order_id"`
	Status       string     `gorm:"not null;default:'pending'" json:"status"`
	Attempts     int        `gorm:"not null;default:0" json:"attempts"`
	LastError    *string    `gorm:"column:last_error" json:"last_error"`
	RestaurantID *string    `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time  `gorm:"not null" json:"created_at"`
	UpdatedAt    time.Time  `gorm:"not null" json:"updated_at"`
	PrintedAt    *time.Time `gorm:"column:printed_at" json:"printed_at"`
}

func (PrintJob) TableName() string { return "print_jobs" }
