package models

import "time"

// ShadowDrift — отчёт фронта при параллельном прогоне v1 ↔ v4.
//
// matched=true → ответы байт-в-байт совпали; diff_size_bytes=0.
// matched=false → расхождение, diff_sample содержит первые 2KB JSON-diff.
//
// Owner Dashboard агрегирует за период:
//
//	SELECT operation, AVG(matched::int) AS match_rate, COUNT(*) AS total
//	FROM shadow_drifts WHERE created_at > now() - interval '24h'
//	GROUP BY operation;
type ShadowDrift struct {
	ID            string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID  string `gorm:"column:restaurant_id;not null;index" json:"restaurant_id"`
	Operation     string `gorm:"not null" json:"operation"`
	Matched       bool `gorm:"not null" json:"matched"`
	V1Status      *int `gorm:"column:v1_status" json:"v1_status"`
	V4Status      *int `gorm:"column:v4_status" json:"v4_status"`
	V1LatencyMs   *int `gorm:"column:v1_latency_ms" json:"v1_latency_ms"`
	V4LatencyMs   *int `gorm:"column:v4_latency_ms" json:"v4_latency_ms"`
	DiffSizeBytes *int `gorm:"column:diff_size_bytes" json:"diff_size_bytes"`
	DiffSample    *string `gorm:"column:diff_sample" json:"diff_sample"`
	UserID        *string `gorm:"column:user_id" json:"user_id"`
	AppVersion    *string `gorm:"column:app_version" json:"app_version"`
	CreatedAt     time.Time `gorm:"not null" json:"created_at"`
}

func (ShadowDrift) TableName() string { return "shadow_drifts" }
