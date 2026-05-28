package models

import "time"

// Session — серверная сессия, выдаётся при PIN-login.
// Token — opaque (32 байта random hex), хранится PRIMARY KEY.
type Session struct {
	Token        string `gorm:"primaryKey;type:text" json:"token"`
	UserID       string `gorm:"column:user_id;type:uuid;not null" json:"user_id"`
	RestaurantID string `gorm:"column:restaurant_id;not null;index" json:"restaurant_id"`
	UserName     *string `gorm:"column:user_name" json:"user_name"`
	Role         *string `json:"role"`
	CreatedAt    time.Time `gorm:"not null" json:"created_at"`
	ExpiresAt    time.Time `gorm:"column:expires_at;not null;index" json:"expires_at"`
	LastSeenAt   time.Time `gorm:"column:last_seen_at;not null" json:"last_seen_at"`
}

func (Session) TableName() string { return "sessions" }
