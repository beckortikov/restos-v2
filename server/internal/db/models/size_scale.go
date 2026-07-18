package models

import "time"

// SizeScale — переиспользуемая шкала размеров («Пиццы 25/30/35»). Продукт
// (через MenuAttribute.SizeScaleID) и полуфабрикат (через
// SemiFinishedType.SizeScaleValueID) ссылаются на неё вместо того, чтобы
// заводить одинаковые значения размера с нуля на каждой карточке.
type SizeScale struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         string    `gorm:"not null" json:"name"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (SizeScale) TableName() string { return "size_scales" }

// SizeScaleValue — элемент шкалы («25», «30», «35»).
type SizeScaleValue struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	SizeScaleID  string    `gorm:"column:size_scale_id;type:uuid;not null;index" json:"size_scale_id"`
	Code         string    `gorm:"not null" json:"code"`
	Title        *string   `json:"title"`
	SortOrder    int       `gorm:"column:sort_order;not null;default:0" json:"sort_order"`
	IsDefault    bool      `gorm:"column:is_default;not null;default:false" json:"is_default"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (SizeScaleValue) TableName() string { return "size_scale_values" }
