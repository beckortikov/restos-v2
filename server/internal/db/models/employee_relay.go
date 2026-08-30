package models

import (
	"time"

	"gorm.io/datatypes"
)

// EmployeeRelayAction — команда «central управляет сотрудником филиала» (см.
// миграцию 097). Как и DeliveryRelayOrder (091) — это не сама мутация, а
// транспорт: central кладёт pending-запись, филиал забирает своим пулером
// (EmployeeRelayPuller, employee_relay_pull.go) и материализует её через
// СВОИ, настоящие UsersService.Create/Patch/SalaryService.SetWorkedDays/
// ToggleDayMultiplier — учётка физически появляется в БД филиала, а не
// остаётся только записью на central.
type EmployeeRelayAction struct {
	ID                 string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AccountID          string `gorm:"column:account_id;type:uuid" json:"account_id"`
	RestaurantID       string `gorm:"column:restaurant_id;type:uuid" json:"restaurant_id"`
	TargetRestaurantID string `gorm:"column:target_restaurant_id;type:uuid;index" json:"target_restaurant_id"`
	// TargetUserID — NULL только для kind=create (сотрудника ещё нет).
	// Значения совпадают на central и филиале (users.id не транслируется,
	// в отличие от menu_item_id у delivery-relay) — central уже видит его в
	// своей реплике users (up-sync).
	TargetUserID *string `gorm:"column:target_user_id;type:uuid" json:"target_user_id,omitempty"`
	// Kind — create|update_identity|update_pay|set_worked_days|
	// toggle_day_multiplier (CHECK в миграции).
	Kind string `json:"kind"`
	// Payload — форма зависит от Kind, см. EmployeeRelay*Payload в
	// employee_relay.go.
	Payload datatypes.JSON `json:"payload"`
	// Status — pending|delivered|failed (CHECK в миграции).
	Status      string     `json:"status"`
	LocalUserID *string    `gorm:"column:local_user_id;type:uuid" json:"local_user_id,omitempty"`
	Error       *string    `json:"error,omitempty"`
	CreatedAt   time.Time  `json:"created_at"`
	UpdatedAt   time.Time  `json:"updated_at"`
	DeliveredAt *time.Time `gorm:"column:delivered_at" json:"delivered_at,omitempty"`
	// CreatedByUserID/Name — реальный central-пользователь (audit.Actor), не
	// синтетическая строка-заглушка, которую филиал использует при
	// материализации (та живёт только в audit_log филиала — central и
	// филиал разные тенанты, id пользователя central там не существует).
	CreatedByUserID *string `gorm:"column:created_by_user_id;type:uuid" json:"created_by_user_id,omitempty"`
	CreatedByName   *string `gorm:"column:created_by_name" json:"created_by_name,omitempty"`
}

func (EmployeeRelayAction) TableName() string { return "employee_relay_actions" }

// EmployeeRelayReceived — идемпотентность НА ФИЛИАЛЕ: какие relay_action_id
// уже применены, чтобы обрыв сети между обработкой и ack не продублировал
// мутацию на следующем тике EmployeeRelayPuller.
type EmployeeRelayReceived struct {
	RelayActionID string    `gorm:"column:relay_action_id;primaryKey;type:uuid" json:"relay_action_id"`
	LocalUserID   string    `gorm:"column:local_user_id;type:uuid" json:"local_user_id"`
	CreatedAt     time.Time `json:"created_at"`
}

func (EmployeeRelayReceived) TableName() string { return "employee_relay_received" }
