package models

import (
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// MenuCategory — категория меню (например «Салаты»).
type MenuCategory struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         string    `gorm:"not null" json:"name"`
	SortOrder    *int      `gorm:"column:sort_order;default:0" json:"sort_order"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (MenuCategory) TableName() string { return "menu_categories" }

// CustomCategory — пользовательская финансовая категория (тип in/out).
type CustomCategory struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         string    `gorm:"not null" json:"name"`
	Type         string    `gorm:"not null;default:'out'" json:"type"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
}

func (CustomCategory) TableName() string { return "custom_categories" }

// MenuItem — блюдо.
type MenuItem struct {
	ID               string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name             *string         `json:"name"`
	Category         *string         `json:"category"`
	Price            decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"price"`
	Emoji            *string         `gorm:"default:''" json:"emoji"`
	ImageURL         *string         `gorm:"column:image_url" json:"image_url"`
	IsAvailable      *bool           `gorm:"column:is_available;default:true" json:"is_available"`
	StopListOverride *bool           `gorm:"column:stop_list_override;default:false" json:"stop_list_override"`
	IsPurchased      bool            `gorm:"column:is_purchased;not null;default:false" json:"is_purchased"`
	// IsBundle — фастфуд-сет (см. BundleSlot/BundleSlotOption, миграция 073).
	// Собран из НАСТОЯЩИХ пунктов меню — у сета самого нет техкарты/цены,
	// цена и списание живут на компонентах.
	IsBundle          bool            `gorm:"column:is_bundle;not null;default:false" json:"is_bundle"`
	COGS              decimal.Decimal `gorm:"column:cogs;type:numeric(14,4);default:0" json:"cogs"`
	CookTimeMin       *int            `gorm:"column:cook_time_min" json:"cook_time_min"`
	Station           *string         `gorm:"default:'hot_kitchen'" json:"station"`
	IsBatchCooking    *bool           `gorm:"column:is_batch_cooking;default:false" json:"is_batch_cooking"`
	PreparedQty       *int            `gorm:"column:prepared_qty;default:0" json:"prepared_qty"`
	Unit              *string         `gorm:"default:'piece'" json:"unit"`
	UnitSize          decimal.Decimal `gorm:"column:unit_size;type:numeric(14,4);default:1" json:"unit_size"`
	SaleStep          decimal.Decimal `gorm:"column:sale_step;type:numeric(14,4);default:0" json:"sale_step"`
	IsDeleted         bool            `gorm:"column:is_deleted;not null;default:false" json:"is_deleted"`
	LowStockThreshold int             `gorm:"column:low_stock_threshold;not null;default:5" json:"low_stock_threshold"`
	// MasterID — связь с мастер-меню сети (ADR-004). NULL → локальное блюдо
	// филиала. Наследуемые поля тянутся из мастера, локальные (price/is_available/
	// оформление) остаются у филиала.
	MasterID *string `gorm:"column:master_id;type:uuid" json:"master_id,omitempty"`
	// ParentID — задан у сгенерированных вариантов (комбинаций атрибутов);
	// NULL — обычное блюдо или продукт-родитель. Варианты скрыты из списков UI.
	ParentID     *string   `gorm:"column:parent_id;type:uuid" json:"parent_id"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (MenuItem) TableName() string { return "menu_items" }

// NetworkMenuItem — мастер-меню сети (ADR-004). Общая база блюд на account_id;
// филиалы наследуют, переопределяют цену/доступность локально.
type NetworkMenuItem struct {
	ID        string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AccountID *string         `gorm:"column:account_id;type:uuid;index" json:"account_id"`
	Name      string          `gorm:"not null" json:"name"`
	Category  *string         `json:"category"`
	BasePrice decimal.Decimal `gorm:"column:base_price;type:numeric(14,4);default:0" json:"base_price"`
	Station   *string         `gorm:"default:'hot_kitchen'" json:"station"`
	Unit      *string         `gorm:"default:'piece'" json:"unit"`
	Emoji     *string         `json:"emoji"`
	CreatedAt time.Time       `json:"created_at"`
	UpdatedAt time.Time       `json:"updated_at"`
}

func (NetworkMenuItem) TableName() string { return "network_menu_items" }

// ModifierGroup — группа модификаторов («Прожарка», «Размер», ...).
type ModifierGroup struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         *string   `json:"name"`
	MenuItemID   *string   `gorm:"column:menu_item_id;type:uuid" json:"menu_item_id"`
	IsRequired   *bool     `gorm:"column:is_required;default:false" json:"is_required"`
	MaxSelect    *int      `gorm:"column:max_select;default:1" json:"max_select"`
	SortOrder    *int      `gorm:"column:sort_order;default:0" json:"sort_order"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
}

func (ModifierGroup) TableName() string { return "modifier_groups" }

// Modifier — конкретный модификатор внутри группы.
type Modifier struct {
	ID        string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	GroupID   *string         `gorm:"column:group_id;type:uuid" json:"group_id"`
	Name      *string         `json:"name"`
	Price     decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"price"`
	IsDefault *bool           `gorm:"column:is_default;default:false" json:"is_default"`
	SortOrder *int            `gorm:"column:sort_order;default:0" json:"sort_order"`
	CreatedAt time.Time       `json:"created_at"`
}

func (Modifier) TableName() string { return "modifiers" }

// BundleSlot — слот фастфуд-сета («Бургер»/«Гарнир»/«Напиток», миграция 073).
// Структурно как ModifierGroup, но у сета ЕСТЬ restaurant_id напрямую (в
// отличие от Modifier/child-таблиц) — слот не имеет смысла без tenant-скоупа
// с самого начала, как у самого MenuItem.
type BundleSlot struct {
	ID               string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID     *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	BundleMenuItemID string    `gorm:"column:bundle_menu_item_id;type:uuid;not null;index" json:"bundle_menu_item_id"`
	Label            string    `gorm:"not null" json:"label"`
	IsRequired       bool      `gorm:"column:is_required;not null;default:true" json:"is_required"`
	MinSelect        int       `gorm:"column:min_select;not null;default:1" json:"min_select"`
	MaxSelect        int       `gorm:"column:max_select;not null;default:1" json:"max_select"`
	SortOrder        int       `gorm:"column:sort_order;not null;default:0" json:"sort_order"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

func (BundleSlot) TableName() string { return "bundle_slots" }

// BundleSlotOption — вариант внутри слота. OptionMenuItemID ссылается на
// НАСТОЯЩИЙ пункт меню (не свободное имя, как у Modifier) — у выбора есть
// своя техкарта/станция/сток без специальной обработки. Price — цена этого
// варианта ВНУТРИ сета (не скидка на заказ, см. миграцию 073).
type BundleSlotOption struct {
	ID               string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	SlotID           string          `gorm:"column:slot_id;type:uuid;not null;index" json:"slot_id"`
	OptionMenuItemID string          `gorm:"column:option_menu_item_id;type:uuid;not null;index" json:"option_menu_item_id"`
	Price            decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"price"`
	IsDefault        bool            `gorm:"column:is_default;not null;default:false" json:"is_default"`
	SortOrder        int             `gorm:"column:sort_order;not null;default:0" json:"sort_order"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

func (BundleSlotOption) TableName() string { return "bundle_slot_options" }

// MenuAttribute — атрибут продукта («Размер», «Вкус»). Живёт на продукте-
// родителе; из декартова произведения значений сервис генерирует варианты.
type MenuAttribute struct {
	ID         string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	MenuItemID string `gorm:"column:menu_item_id;type:uuid;not null;index" json:"menu_item_id"`
	Name       string `gorm:"not null" json:"name"`
	SortOrder  int    `gorm:"column:sort_order;not null;default:0" json:"sort_order"`
	// SizeScaleID — если задан, значения атрибута зеркалятся из этой шкалы
	// (см. syncAttributeDefs в menu_variants.go) вместо ручного ввода.
	SizeScaleID  *string   `gorm:"column:size_scale_id;type:uuid" json:"size_scale_id"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (MenuAttribute) TableName() string { return "menu_attributes" }

// MenuAttributeValue — значение атрибута («1 л») — чистый лейбл. Цена и
// закупка живут на комбинации (строка варианта menu_items).
type MenuAttributeValue struct {
	ID          string `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AttributeID string `gorm:"column:attribute_id;type:uuid;not null;index" json:"attribute_id"`
	Label       string `gorm:"not null" json:"label"`
	SortOrder   int    `gorm:"column:sort_order;not null;default:0" json:"sort_order"`
	// SizeScaleValueID — какое значение шкалы (SizeScaleValue) зеркалит эта
	// строка, когда родительский MenuAttribute.SizeScaleID задан. NULL — это
	// обычный свободный лейбл (не связанный со шкалой).
	SizeScaleValueID *string   `gorm:"column:size_scale_value_id;type:uuid" json:"size_scale_value_id"`
	RestaurantID     *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

func (MenuAttributeValue) TableName() string { return "menu_attribute_values" }

// MenuItemVariantValue — связка «вариант ↔ выбранное значение атрибута».
type MenuItemVariantValue struct {
	MenuItemID   string    `gorm:"column:menu_item_id;type:uuid;primaryKey" json:"menu_item_id"`
	ValueID      string    `gorm:"column:value_id;type:uuid;primaryKey" json:"value_id"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (MenuItemVariantValue) TableName() string { return "menu_item_variant_values" }

// TechCardLine — строка тех. карты (блюдо → ингредиент или полуфабрикат).
type TechCardLine struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	MenuItemID   *string         `gorm:"column:menu_item_id;type:uuid;index" json:"menu_item_id"`
	IngredientID *string         `gorm:"column:ingredient_id;type:uuid" json:"ingredient_id"`
	SemiTypeID   *string         `gorm:"column:semi_type_id;type:uuid" json:"semi_type_id"`
	Name         *string         `json:"name"`
	Qty          decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"qty"`
	Unit         *string         `json:"unit"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
}

func (TechCardLine) TableName() string { return "tech_card_lines" }
