package models

import (
	"time"

	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Restaurant — тенант. Все остальные таблицы фильтруются по restaurant_id.
type Restaurant struct {
	ID                 string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name               string          `gorm:"not null" json:"name"`
	Slug               *string         `gorm:"column:slug" json:"slug"`
	LogoURL            *string         `gorm:"column:logo_url" json:"logo_url"`
	Address            *string         `json:"address"`
	Phone              *string         `json:"phone"`
	Currency           *string         `gorm:"default:'TJS'" json:"currency"`
	ServicePercent     decimal.Decimal `gorm:"type:numeric(14,4);default:10" json:"service_percent"`
	Timezone           *string         `gorm:"default:'Asia/Dushanbe'" json:"timezone"`
	EnforceStockCheck  *bool           `gorm:"column:enforce_stock_check;default:false" json:"enforce_stock_check"`
	TechCardsEnabled   *bool           `gorm:"column:tech_cards_enabled;default:true" json:"tech_cards_enabled"`
	AutoReadyMode      *bool           `gorm:"column:auto_ready_mode;default:false" json:"auto_ready_mode"`
	AutoReadyBufferMin *int            `gorm:"column:auto_ready_buffer_min;default:5" json:"auto_ready_buffer_min"`
	LocalServerIP      *string         `gorm:"column:local_server_ip" json:"local_server_ip"`
	LicenseKey         *string         `gorm:"column:license_key" json:"license_key"`
	LicenseExpiresAt   *time.Time      `gorm:"column:license_expires_at" json:"license_expires_at"`
	// AccountID — владелец сети (Phase 1 multi-branch). Заполняется при
	// activate из payload.aid. Empty/NULL → одиночный ресторан.
	AccountID         *string    `gorm:"column:account_id" json:"account_id,omitempty"`
	IsBlocked         *bool      `gorm:"column:is_blocked;default:false" json:"is_blocked"`
	BlockReason       *string    `gorm:"column:block_reason" json:"block_reason"`
	LastSeenAt        *time.Time `gorm:"column:last_seen_at" json:"last_seen_at"`
	AppVersion        *string    `gorm:"column:app_version" json:"app_version"`
	SupplyAllowNeg    bool       `gorm:"column:supply_allow_negative;not null;default:true" json:"supply_allow_negative"`
	PinLockEnabled    *bool      `gorm:"column:pin_lock_enabled;default:false" json:"pin_lock_enabled"`
	PinLockTimeoutMin *int       `gorm:"column:pin_lock_timeout_min;default:5" json:"pin_lock_timeout_min"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
}

func (Restaurant) TableName() string { return "restaurants" }

// User — кассиры/повара/официанты/менеджеры.
// Owner-роль в v4 не имеет смысла локально (см. CLAUDE.md), но запись возможна.
type User struct {
	ID       string  `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AuthID   *string `gorm:"column:auth_id;type:uuid" json:"auth_id"`
	Username *string `json:"username"`
	// Password / PIN никогда не отдаются в API-ответах. Десериализуются на вход
	// через service.UserInput, не через сам models.User. См. F1 (security).
	Password     *string         `gorm:"default:'1234'" json:"-"`
	PIN          *string         `gorm:"column:pin" json:"-"`
	Name         *string         `json:"name"`
	Role         *string         `gorm:"default:'waiter'" json:"role"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	Phone        *string         `json:"phone"`
	Email        *string         `json:"email"`
	Position     *string         `json:"position"`
	BirthDate    *string         `gorm:"column:birth_date" json:"birth_date"`
	Station      *string         `json:"station"`
	ShiftNumber  *int            `gorm:"column:shift_number" json:"shift_number"`
	Salary       decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"salary"`
	HourlyRate   decimal.Decimal `gorm:"column:hourly_rate;type:numeric(14,4);default:0" json:"hourly_rate"`
	Advance      decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"advance"`
	Deductions   decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"deductions"`
	Permissions  datatypes.JSON  `gorm:"type:jsonb" json:"permissions"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

func (User) TableName() string { return "users" }

// AuditLog — лог всех мутаций. Заполняется централизованным GORM-хуком
// в internal/audit/hooks.go. Никакого ручного Insert из сервисов.
type AuditLog struct {
	ID           string         `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Action       *string        `json:"action"`
	EntityType   *string        `gorm:"column:entity_type" json:"entity_type"`
	EntityID     *string        `gorm:"column:entity_id" json:"entity_id"`
	EntityName   *string        `gorm:"column:entity_name" json:"entity_name"`
	Details      datatypes.JSON `gorm:"type:jsonb" json:"details"`
	UserID       *string        `gorm:"column:user_id" json:"user_id"`
	UserName     *string        `gorm:"column:user_name" json:"user_name"`
	RestaurantID *string        `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time      `json:"created_at"`
}

func (AuditLog) TableName() string { return "audit_log" }
