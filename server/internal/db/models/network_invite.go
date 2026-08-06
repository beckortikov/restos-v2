package models

import "time"

// NetworkInvite — одноразовый код приглашения филиала в сеть (ADR-003,
// продолжение). НЕ несёт sync-секрет — только ссылку на него: филиал
// обменивает code на sync_settings.token+restaurants.account_id через
// POST /api/v1/sync/pair, после чего used_at гасит код навсегда.
type NetworkInvite struct {
	ID                   string     `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AccountID            string     `gorm:"column:account_id;type:uuid;index" json:"account_id"`
	Code                 string     `gorm:"column:code;uniqueIndex" json:"code"`
	Label                *string    `json:"label,omitempty"`
	CreatedBy            *string    `gorm:"column:created_by" json:"created_by,omitempty"`
	CreatedAt            time.Time  `json:"created_at"`
	ExpiresAt            time.Time  `gorm:"column:expires_at" json:"expires_at"`
	UsedAt               *time.Time `gorm:"column:used_at" json:"used_at,omitempty"`
	UsedByRestaurantID   *string    `gorm:"column:used_by_restaurant_id" json:"used_by_restaurant_id,omitempty"`
	UsedByRestaurantName *string    `gorm:"column:used_by_restaurant_name" json:"used_by_restaurant_name,omitempty"`
}

func (NetworkInvite) TableName() string { return "network_invites" }
