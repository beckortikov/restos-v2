package models

import (
	"time"

	"gorm.io/datatypes"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Ingredient — ингредиент склада.
// qty обновляется ТОЛЬКО через event-stream stock_movements (см. CLAUDE.md).
// Прямой UPDATE qty в репозиториях — запрещён.
type Ingredient struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         *string         `json:"name"`
	Category     *string         `json:"category"`
	Qty          decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"qty"`
	MinQty       decimal.Decimal `gorm:"column:min_qty;type:numeric(14,4);default:0" json:"min_qty"`
	Unit         *string         `json:"unit"`
	PricePerUnit decimal.Decimal `gorm:"column:price_per_unit;type:numeric(14,4);default:0" json:"price_per_unit"`
	WastePercent decimal.Decimal `gorm:"column:waste_percent;type:numeric(14,4);default:0" json:"waste_percent"`
	// UnitWeight — вес/объём ОДНОЙ складской единицы, если основная единица
	// штучная (шт/уп/бут), а тех-карта пишется в весе/объёме. Напр. «1 банка = 340 г».
	// 0 = фактор не задан → конвертация из рецептурной единицы работает как раньше
	// (только в пределах одной размерности массы/объёма). См. units.ConvertToStock.
	UnitWeight decimal.Decimal `gorm:"column:unit_weight;type:numeric(14,4);default:0" json:"unit_weight"`
	// UnitWeightUnit — единица, в которой задан UnitWeight (г/мл), т.е. единица
	// той же размерности, что и рецепт.
	UnitWeightUnit *string `gorm:"column:unit_weight_unit" json:"unit_weight_unit"`
	IsFood         *bool   `gorm:"column:is_food;default:true" json:"is_food"`
	// WarehouseID — склад, где целиком лежит товар (мультисклад, Фаза 1).
	// Списание продажи/расхода идёт с этого склада; перемещение = смена значения.
	WarehouseID  *string   `gorm:"column:warehouse_id;type:uuid;index" json:"warehouse_id"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (Ingredient) TableName() string { return "ingredients" }

// BeforeCreate — мультисклад: если склад явно не задан, привязываем товар по типу
// (еда → «Продукты», не-еда → «Хозтовары»). Покупные товары получают склад
// «Покупные товары» ЯВНО в местах создания (menu_write/menu_variants), поэтому
// сюда они приходят уже с WarehouseID и хук их не трогает. Если складов ещё нет
// (совсем новый ресторан) — оставляем NULL: self-heal на старте доразметит.
// Единый вход для всех путей создания (import/seed/будущие) — не дублируем логику.
func (i *Ingredient) BeforeCreate(tx *gorm.DB) error {
	if i.WarehouseID != nil || i.RestaurantID == nil || *i.RestaurantID == "" {
		return nil
	}
	kind := "products"
	if i.IsFood != nil && !*i.IsFood {
		kind = "supplies"
	}
	var w Warehouse
	if err := tx.Session(&gorm.Session{NewDB: true}).
		Where("restaurant_id = ? AND kind = ?", *i.RestaurantID, kind).First(&w).Error; err == nil {
		i.WarehouseID = &w.ID
	}
	return nil
}

// Warehouse — склад (мультисклад, Фаза 1). Ровно 3 фиксированных на ресторан:
// products «Продукты», purchased «Покупные товары», supplies «Хозтовары».
type Warehouse struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         *string   `json:"name"`
	Kind         *string   `json:"kind"` // products | purchased | supplies
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (Warehouse) TableName() string { return "warehouses" }

// StockMovement — append-only event-stream движений склада.
// type: receipt | writeoff | order_deduct | inventory_correction | ...
type StockMovement struct {
	ID             string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Type           *string         `json:"type"`
	IngredientID   *string         `gorm:"column:ingredient_id" json:"ingredient_id"`
	IngredientName *string         `gorm:"column:ingredient_name" json:"ingredient_name"`
	Description    *string         `json:"description"`
	Qty            decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"qty"`
	Unit           *string         `json:"unit"`
	BelowZero      *bool           `gorm:"column:below_zero;default:false" json:"below_zero"`
	// Склад движения. Для type=transfer заполнены FromWarehouseID/ToWarehouseID;
	// для остальных типов — WarehouseID (где произошло движение).
	WarehouseID     *string   `gorm:"column:warehouse_id;type:uuid" json:"warehouse_id"`
	FromWarehouseID *string   `gorm:"column:from_warehouse_id;type:uuid" json:"from_warehouse_id"`
	ToWarehouseID   *string   `gorm:"column:to_warehouse_id;type:uuid" json:"to_warehouse_id"`
	RestaurantID    *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt       time.Time `json:"created_at"`
	// Колонка БД "timestamp" заполняется автоматически (DEFAULT now()).
	// В Go-модели не маппим — колонка зарезервирована, плюс CreatedAt
	// покрывает ту же информацию. Если потребуется чтение — добавить
	// поле с gorm:"->" (read-only) и column:"timestamp".
}

func (StockMovement) TableName() string { return "stock_movements" }

// BeforeCreate — централизованная привязка движения к складу (мультисклад, Ф1).
// Если warehouse_id не задан явно, берём склад товара (ingredients.warehouse_id).
// Так ВСЕ движения (продажа/приёмка/списание/инвентаризация/…) несут склад без
// правки каждого места создания — минимум регрессии. Перемещение (type=transfer)
// задаёт warehouse_id/from/to само → метод его не трогает (WarehouseID != nil).
func (m *StockMovement) BeforeCreate(tx *gorm.DB) error {
	if m.WarehouseID != nil || m.IngredientID == nil || *m.IngredientID == "" {
		return nil
	}
	var ing Ingredient
	if err := tx.Session(&gorm.Session{NewDB: true}).
		Select("warehouse_id").Where("id = ?", *m.IngredientID).First(&ing).Error; err == nil {
		m.WarehouseID = ing.WarehouseID
	}
	return nil
}

// Supplier — поставщик.
type Supplier struct {
	ID               string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name             *string         `json:"name"`
	ContactPerson    *string         `gorm:"column:contact_person" json:"contact_person"`
	Phone            *string         `json:"phone"`
	Categories       datatypes.JSON  `gorm:"type:jsonb" json:"categories"`
	PaymentTermsDays *int            `gorm:"column:payment_terms_days;default:0" json:"payment_terms_days"`
	CreditLimit      decimal.Decimal `gorm:"column:credit_limit;type:numeric(14,4);default:0" json:"credit_limit"`
	CurrentDebt      decimal.Decimal `gorm:"column:current_debt;type:numeric(14,4);default:0" json:"current_debt"`
	RestaurantID     *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

func (Supplier) TableName() string { return "suppliers" }

// StockReceipt — приёмка от поставщика.
type StockReceipt struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	SupplierID   *string         `gorm:"column:supplier_id" json:"supplier_id"`
	SupplierName *string         `gorm:"column:supplier_name" json:"supplier_name"`
	Date         *string         `json:"date"`
	Note         *string         `json:"note"`
	TotalAmount  decimal.Decimal `gorm:"column:total_amount;type:numeric(14,4);default:0" json:"total_amount"`
	PaymentType  *string         `gorm:"column:payment_type;default:'paid'" json:"payment_type"`
	PaidAmount   decimal.Decimal `gorm:"column:paid_amount;type:numeric(14,4);default:0" json:"paid_amount"`
	DebtAmount   decimal.Decimal `gorm:"column:debt_amount;type:numeric(14,4);default:0" json:"debt_amount"`
	DueDate      *string         `gorm:"column:due_date" json:"due_date"`
	ConfirmedAt  *time.Time      `gorm:"column:confirmed_at" json:"confirmed_at"`
	ConfirmedBy  *string         `gorm:"column:confirmed_by" json:"confirmed_by"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

func (StockReceipt) TableName() string { return "stock_receipts" }

// StockReceiptLine — строка приёмки.
type StockReceiptLine struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	ReceiptID    *string         `gorm:"column:receipt_id;type:uuid;index" json:"receipt_id"`
	IngredientID *string         `gorm:"column:ingredient_id" json:"ingredient_id"`
	Name         *string         `json:"name"`
	Qty          decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"qty"`
	Unit         *string         `json:"unit"`
	PricePerUnit decimal.Decimal `gorm:"column:price_per_unit;type:numeric(14,4);default:0" json:"price_per_unit"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

func (StockReceiptLine) TableName() string { return "stock_receipt_lines" }

// StockWriteoff — списание со склада.
type StockWriteoff struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Reason       *string         `json:"reason"`
	Description  *string         `json:"description"`
	TotalCost    decimal.Decimal `gorm:"column:total_cost;type:numeric(14,4);default:0" json:"total_cost"`
	CreatedBy    *string         `gorm:"column:created_by" json:"created_by"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

func (StockWriteoff) TableName() string { return "stock_writeoffs" }

// StockWriteoffLine — строка списания.
type StockWriteoffLine struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	WriteoffID   *string         `gorm:"column:writeoff_id;type:uuid;index" json:"writeoff_id"`
	IngredientID *string         `gorm:"column:ingredient_id" json:"ingredient_id"`
	Name         *string         `json:"name"`
	Qty          decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"qty"`
	Unit         *string         `json:"unit"`
	Cost         decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"cost"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

func (StockWriteoffLine) TableName() string { return "stock_writeoff_lines" }

// SemiFinishedType — полуфабрикат (например «Бульон»).
type SemiFinishedType struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         *string         `json:"name"`
	OutputUnit   *string         `gorm:"column:output_unit;default:'кг'" json:"output_unit"`
	YieldPercent decimal.Decimal `gorm:"column:yield_percent;type:numeric(14,4);default:100" json:"yield_percent"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

func (SemiFinishedType) TableName() string { return "semi_finished_types" }

// SemiRecipeLine — рецепт полуфабриката.
type SemiRecipeLine struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	SemiTypeID   *string         `gorm:"column:semi_type_id;type:uuid" json:"semi_type_id"`
	IngredientID *string         `gorm:"column:ingredient_id;type:uuid" json:"ingredient_id"`
	Name         *string         `json:"name"`
	QtyPerUnit   decimal.Decimal `gorm:"column:qty_per_unit;type:numeric(14,4);default:0" json:"qty_per_unit"`
	Unit         *string         `json:"unit"`
	CreatedAt    time.Time       `json:"created_at"`
}

func (SemiRecipeLine) TableName() string { return "semi_recipe_lines" }

// SemiFinishedStock — остатки полуфабрикатов.
type SemiFinishedStock struct {
	ID             string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	SemiTypeID     *string         `gorm:"column:semi_type_id;type:uuid" json:"semi_type_id"`
	Name           *string         `json:"name"`
	Qty            decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"qty"`
	Unit           *string         `json:"unit"`
	PricePerUnit   decimal.Decimal `gorm:"column:price_per_unit;type:numeric(14,4);default:0" json:"price_per_unit"`
	LastProducedAt *time.Time      `gorm:"column:last_produced_at" json:"last_produced_at"`
	RestaurantID   *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

func (SemiFinishedStock) TableName() string { return "semi_finished_stock" }

// BatchCookingLog — лог партионной готовки (для batch-блюд).
type BatchCookingLog struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	MenuItemID   *string         `gorm:"column:menu_item_id;type:uuid" json:"menu_item_id"`
	MenuItemName *string         `gorm:"column:menu_item_name" json:"menu_item_name"`
	Qty          *int            `gorm:"default:0" json:"qty"`
	ProducedBy   *string         `gorm:"column:produced_by" json:"produced_by"`
	ProducedByID *string         `gorm:"column:produced_by_id;type:uuid" json:"produced_by_id"`
	CostTotal    decimal.Decimal `gorm:"column:cost_total;type:numeric(14,4);default:0" json:"cost_total"`
	Reason       *string         `json:"reason"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
}

func (BatchCookingLog) TableName() string { return "batch_cooking_logs" }

// SupplyExpense — выдача со склада не-food (хоз. товары и т.п.).
type SupplyExpense struct {
	ID             string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	IngredientID   *string         `gorm:"column:ingredient_id;type:uuid" json:"ingredient_id"`
	IngredientName *string         `gorm:"column:ingredient_name" json:"ingredient_name"`
	Qty            decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"qty"`
	Unit           *string         `json:"unit"`
	Reason         *string         `json:"reason"`
	IssuedTo       *string         `gorm:"column:issued_to" json:"issued_to"`
	Note           *string         `json:"note"`
	CreatedBy      *string         `gorm:"column:created_by" json:"created_by"`
	RestaurantID   *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt      time.Time       `json:"created_at"`
}

func (SupplyExpense) TableName() string { return "supply_expenses" }

// InventoryCheck — инвентаризация (draft → applied).
type InventoryCheck struct {
	ID            string     `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID  string     `gorm:"column:restaurant_id;type:uuid;not null;index" json:"restaurant_id"`
	ConductedBy   string     `gorm:"column:conducted_by;not null" json:"conducted_by"`
	ConductedByID *string    `gorm:"column:conducted_by_id;type:uuid" json:"conducted_by_id"`
	Status        string     `gorm:"not null;default:'draft'" json:"status"`
	TotalItems    *int       `gorm:"column:total_items;default:0" json:"total_items"`
	ItemsWithDiff *int       `gorm:"column:items_with_diff;default:0" json:"items_with_diff"`
	Note          *string    `gorm:"default:''" json:"note"`
	CreatedAt     time.Time  `json:"created_at"`
	AppliedAt     *time.Time `gorm:"column:applied_at" json:"applied_at"`
}

func (InventoryCheck) TableName() string { return "inventory_checks" }

// InventoryCheckLine — позиция инвентаризации.
type InventoryCheckLine struct {
	ID             string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	CheckID        string          `gorm:"column:check_id;type:uuid;not null;index" json:"check_id"`
	IngredientID   string          `gorm:"column:ingredient_id;type:uuid;not null" json:"ingredient_id"`
	IngredientName string          `gorm:"column:ingredient_name;not null" json:"ingredient_name"`
	Unit           string          `gorm:"not null" json:"unit"`
	SystemQty      decimal.Decimal `gorm:"column:system_qty;type:numeric(14,4);not null;default:0" json:"system_qty"`
	ActualQty      decimal.Decimal `gorm:"column:actual_qty;type:numeric(14,4);not null;default:0" json:"actual_qty"`
	Diff           decimal.Decimal `gorm:"type:numeric(14,4);not null;default:0" json:"diff"`
	RestaurantID   string          `gorm:"column:restaurant_id;type:uuid;not null;index" json:"restaurant_id"`
}

func (InventoryCheckLine) TableName() string { return "inventory_check_lines" }

// StockReturn — возврат товара поставщику (порча/бой/просрочка).
//
// Не путать с StockWriteoff: списание — наш убыток (бьёт по прибыли в ОПиУ),
// возврат — сторно закупки (товар уехал назад, деньги/долг вернулись).
// Всегда привязан к накладной: цена возврата берётся из её строк, а не из
// средневзвешенной себестоимости склада. См. миграцию 042.
type StockReturn struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	ReceiptID    string          `gorm:"column:receipt_id;type:uuid;not null;index" json:"receipt_id"`
	SupplierID   *string         `gorm:"column:supplier_id" json:"supplier_id"`
	SupplierName *string         `gorm:"column:supplier_name" json:"supplier_name"`
	Date         *string         `json:"date"`
	Reason       string          `gorm:"not null;default:'spoilage'" json:"reason"`
	Note         *string         `json:"note"`
	TotalAmount  decimal.Decimal `gorm:"column:total_amount;type:numeric(14,4);not null;default:0" json:"total_amount"`
	// RefundType: debt — уменьшили долг поставщику; money — вернули деньги на счёт.
	RefundType string  `gorm:"column:refund_type;not null;default:'debt'" json:"refund_type"`
	AccountID  *string `gorm:"column:account_id" json:"account_id"`
	CreatedBy  *string `gorm:"column:created_by" json:"created_by"`
	// CancelledAt — сторно: товар вернулся на склад, деньги/долг откатились.
	// Строка не удаляется (append-only), но перестаёт считаться в guard'е
	// «нельзя вернуть больше, чем пришло».
	CancelledAt  *time.Time `gorm:"column:cancelled_at" json:"cancelled_at"`
	CancelledBy  *string    `gorm:"column:cancelled_by" json:"cancelled_by"`
	RestaurantID *string    `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time  `json:"created_at"`
	UpdatedAt    time.Time  `json:"updated_at"`
}

func (StockReturn) TableName() string { return "stock_returns" }

// StockReturnLine — строка возврата. Привязана к строке накладной
// (ReceiptLineID): по ней берётся цена и считается guard «нельзя вернуть
// больше, чем пришло».
type StockReturnLine struct {
	ID            string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	ReturnID      string          `gorm:"column:return_id;type:uuid;not null;index" json:"return_id"`
	ReceiptLineID string          `gorm:"column:receipt_line_id;type:uuid;not null;index" json:"receipt_line_id"`
	IngredientID  *string         `gorm:"column:ingredient_id" json:"ingredient_id"`
	Name          *string         `json:"name"`
	Qty           decimal.Decimal `gorm:"type:numeric(14,4);not null;default:0" json:"qty"`
	Unit          *string         `json:"unit"`
	PricePerUnit  decimal.Decimal `gorm:"column:price_per_unit;type:numeric(14,4);not null;default:0" json:"price_per_unit"`
	// CostRolledBack — откатывал ли возврат средневзвешенную себестоимость по
	// этой строке. Нужен сторно, чтобы зеркалить возврат, а не двигать цену в
	// свою сторону: иначе цикл «возврат + сторно» завышает стоимость запасов
	// (см. миграцию 045). Решение принимается по каждому ингредиенту отдельно,
	// поэтому флаг на строке, а не на документе.
	CostRolledBack bool      `gorm:"column:cost_rolled_back;not null;default:false" json:"cost_rolled_back"`
	CreatedAt      time.Time `json:"created_at"`
	UpdatedAt      time.Time `json:"updated_at"`
}

func (StockReturnLine) TableName() string { return "stock_return_lines" }
