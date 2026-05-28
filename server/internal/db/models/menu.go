package models

import (
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// MenuCategory — категория меню (например «Салаты»).
type MenuCategory struct {
	ID           string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         string `gorm:"not null" json:"name"`
	SortOrder    *int `gorm:"column:sort_order;default:0" json:"sort_order"`
	RestaurantID *string `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (MenuCategory) TableName() string { return "menu_categories" }

// CustomCategory — пользовательская финансовая категория (тип in/out).
type CustomCategory struct {
	ID           string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         string `gorm:"not null" json:"name"`
	Type         string `gorm:"not null;default:'out'" json:"type"`
	RestaurantID *string `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
}

func (CustomCategory) TableName() string { return "custom_categories" }

// MenuItem — блюдо.
type MenuItem struct {
	ID                string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name              *string `json:"name"`
	Category          *string `json:"category"`
	Price             decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"price"`
	Emoji             *string `gorm:"default:''" json:"emoji"`
	ImageURL          *string `gorm:"column:image_url" json:"image_url"`
	IsAvailable       *bool `gorm:"column:is_available;default:true" json:"is_available"`
	StopListOverride  *bool `gorm:"column:stop_list_override;default:false" json:"stop_list_override"`
	COGS              decimal.Decimal `gorm:"column:cogs;type:numeric(14,4);default:0" json:"cogs"`
	CookTimeMin       *int `gorm:"column:cook_time_min" json:"cook_time_min"`
	Station           *string `gorm:"default:'hot_kitchen'" json:"station"`
	IsBatchCooking    *bool `gorm:"column:is_batch_cooking;default:false" json:"is_batch_cooking"`
	PreparedQty       *int `gorm:"column:prepared_qty;default:0" json:"prepared_qty"`
	Unit              *string `gorm:"default:'piece'" json:"unit"`
	UnitSize          decimal.Decimal `gorm:"column:unit_size;type:numeric(14,4);default:1" json:"unit_size"`
	SaleStep          decimal.Decimal `gorm:"column:sale_step;type:numeric(14,4);default:0" json:"sale_step"`
	IsDeleted         bool `gorm:"column:is_deleted;not null;default:false" json:"is_deleted"`
	LowStockThreshold int `gorm:"column:low_stock_threshold;not null;default:5" json:"low_stock_threshold"`
	RestaurantID      *string `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

func (MenuItem) TableName() string { return "menu_items" }

// ModifierGroup — группа модификаторов («Прожарка», «Размер», ...).
type ModifierGroup struct {
	ID           string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         *string `json:"name"`
	MenuItemID   *string `gorm:"column:menu_item_id;type:uuid" json:"menu_item_id"`
	IsRequired   *bool `gorm:"column:is_required;default:false" json:"is_required"`
	MaxSelect    *int `gorm:"column:max_select;default:1" json:"max_select"`
	SortOrder    *int `gorm:"column:sort_order;default:0" json:"sort_order"`
	RestaurantID *string `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
}

func (ModifierGroup) TableName() string { return "modifier_groups" }

// Modifier — конкретный модификатор внутри группы.
type Modifier struct {
	ID        string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	GroupID   *string `gorm:"column:group_id;type:uuid" json:"group_id"`
	Name      *string `json:"name"`
	Price     decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"price"`
	IsDefault *bool `gorm:"column:is_default;default:false" json:"is_default"`
	SortOrder *int `gorm:"column:sort_order;default:0" json:"sort_order"`
	CreatedAt time.Time `json:"created_at"`
}

func (Modifier) TableName() string { return "modifiers" }

// TechCardLine — строка тех. карты (блюдо → ингредиент или полуфабрикат).
type TechCardLine struct {
	ID           string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	MenuItemID   *string `gorm:"column:menu_item_id;type:uuid;index" json:"menu_item_id"`
	IngredientID *string `gorm:"column:ingredient_id;type:uuid" json:"ingredient_id"`
	SemiTypeID   *string `gorm:"column:semi_type_id;type:uuid" json:"semi_type_id"`
	Name         *string `json:"name"`
	Qty          decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"qty"`
	Unit         *string `json:"unit"`
	RestaurantID *string `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
}

func (TechCardLine) TableName() string { return "tech_card_lines" }
