package models

import (
	"time"

	"gorm.io/datatypes"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Restaurant — тенант. Все остальные таблицы фильтруются по restaurant_id.
type Restaurant struct {
	ID             string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name           string          `gorm:"not null" json:"name"`
	Slug           *string         `gorm:"column:slug" json:"slug"`
	LogoURL        *string         `gorm:"column:logo_url" json:"logo_url"`
	Address        *string         `json:"address"`
	Phone          *string         `json:"phone"`
	Currency       *string         `gorm:"default:'TJS'" json:"currency"`
	ServicePercent decimal.Decimal `gorm:"type:numeric(14,4);default:10" json:"service_percent"`
	// DiscountApprovalThreshold — скидка ВЫШЕ этого % требует одобрения
	// менеджера/владельца при закрытии заказа (см. orders_close.go). Владелец
	// настраивает в настройках. DEFAULT 10 — прежнее захардкоженное поведение.
	DiscountApprovalThreshold decimal.Decimal `gorm:"column:discount_approval_threshold;type:numeric(14,4);default:10" json:"discount_approval_threshold"`
	Timezone                  *string         `gorm:"default:'Asia/Dushanbe'" json:"timezone"`
	// Политика опозданий (105). Штраф = fixed + per_minute × (минуты сверх
	// грейса), не больше max (0 = без потолка). Считается, но НЕ списывается
	// автоматически — предлагается человеку в перекличке.
	LateGraceMinutes  int             `gorm:"column:late_grace_minutes;not null;default:5" json:"late_grace_minutes"`
	LateFineFixed     decimal.Decimal `gorm:"column:late_fine_fixed;type:numeric(14,4);not null;default:0" json:"late_fine_fixed"`
	LateFinePerMinute decimal.Decimal `gorm:"column:late_fine_per_minute;type:numeric(14,4);not null;default:0" json:"late_fine_per_minute"`
	LateFineMax       decimal.Decimal `gorm:"column:late_fine_max;type:numeric(14,4);not null;default:0" json:"late_fine_max"`
	// ShiftRoundingMinutes (107) — округление длительности смены при почасовой
	// оплате. 0 = не округлять. При дневной и окладе не участвует.
	ShiftRoundingMinutes int   `gorm:"column:shift_rounding_minutes;not null;default:0" json:"shift_rounding_minutes"`
	EnforceStockCheck    *bool `gorm:"column:enforce_stock_check;default:false" json:"enforce_stock_check"`
	TechCardsEnabled     *bool `gorm:"column:tech_cards_enabled;default:true" json:"tech_cards_enabled"`
	// ShiftBalanceCorrectedAt — маркер разовой коррекции балансов под фикс Н13
	// (v3.16.94+). NULL = не выполнялась; заполнен = повтор запрещён.
	ShiftBalanceCorrectedAt *time.Time `gorm:"column:shift_balance_corrected_at" json:"shift_balance_corrected_at,omitempty"`
	AutoReadyMode           *bool      `gorm:"column:auto_ready_mode;default:false" json:"auto_ready_mode"`
	AutoReadyBufferMin      *int       `gorm:"column:auto_ready_buffer_min;default:5" json:"auto_ready_buffer_min"`
	LocalServerIP           *string    `gorm:"column:local_server_ip" json:"local_server_ip"`
	LicenseKey              *string    `gorm:"column:license_key" json:"license_key"`
	LicenseExpiresAt        *time.Time `gorm:"column:license_expires_at" json:"license_expires_at"`
	// LicenseIssuedAt — когда выписан токен (v2.6.0+). Используется для
	// clock-skew check: если now() < issued_at → tampered clock → lock.
	// Legacy-рестораны до v2.6.0 имеют NULL → skip check (backward compat).
	LicenseIssuedAt *time.Time `gorm:"column:license_issued_at" json:"license_issued_at,omitempty"`
	// LicenseGraceDays / LicenseWarningDays — per-key периоды (v2.1.3).
	// Заполняются из license-токена на activate'е. Дефолт 7+7 для legacy.
	LicenseGraceDays   int `gorm:"column:license_grace_days;not null;default:7" json:"license_grace_days"`
	LicenseWarningDays int `gorm:"column:license_warning_days;not null;default:7" json:"license_warning_days"`
	// AccountID — владелец сети (Phase 1 multi-branch). Заполняется при
	// activate из payload.aid. Empty/NULL → одиночный ресторан.
	AccountID *string `gorm:"column:account_id" json:"account_id,omitempty"`
	// Kind — тип точки в сети (ADR-003): 'outlet' (обычный филиал) |
	// 'central_warehouse' (центральный склад). DEFAULT 'outlet'.
	Kind *string `gorm:"column:kind;default:'outlet'" json:"kind,omitempty"`
	// SyncTokenHash — SHA-256 персонального sync-секрета филиала (Фаза Г,
	// миграция 080). Живёт на CENTRAL, в теневой строке филиала; сам токен
	// центру не нужен и не хранится. Никогда не отдаётся наружу (`json:"-"`):
	// даже хеш — лишняя подсказка в ответе API.
	SyncTokenHash     *string    `gorm:"column:sync_token_hash" json:"-"`
	IsBlocked         *bool      `gorm:"column:is_blocked;default:false" json:"is_blocked"`
	BlockReason       *string    `gorm:"column:block_reason" json:"block_reason"`
	LastSeenAt        *time.Time `gorm:"column:last_seen_at" json:"last_seen_at"`
	AppVersion        *string    `gorm:"column:app_version" json:"app_version"`
	SupplyAllowNeg    bool       `gorm:"column:supply_allow_negative;not null;default:true" json:"supply_allow_negative"`
	PinLockEnabled    *bool      `gorm:"column:pin_lock_enabled;default:false" json:"pin_lock_enabled"`
	PinLockTimeoutMin *int       `gorm:"column:pin_lock_timeout_min;default:5" json:"pin_lock_timeout_min"`
	// OnScreenKeyboardEnabled — экранная клавиатура (iiko-style) на POS/смене/зале.
	// Default false: нужна только на тач-терминалах без физической клавиатуры.
	OnScreenKeyboardEnabled *bool `gorm:"column:on_screen_keyboard_enabled;default:false" json:"on_screen_keyboard_enabled"`
	// Режим обслуживания (041). TablesEnabled=false → фастфуд «в зал по номеру»
	// без столов. KitchenOnPay=true → кухонный бегунок печатается на оплате.
	// PosV2Default=true → новый POS по умолчанию на кассах.
	TablesEnabled *bool `gorm:"column:tables_enabled;not null;default:true" json:"tables_enabled"`
	KitchenOnPay  *bool `gorm:"column:kitchen_on_pay;not null;default:false" json:"kitchen_on_pay"`
	PosV2Default  *bool `gorm:"column:pos_v2_default;not null;default:false" json:"pos_v2_default"`
	// Доставка (052). DeliveryEnabled=false → в POS только «Зал» и «С собой».
	// DeliveryContactsRequired=true → перед оплатой заказа-доставки касса
	// спрашивает телефон и адрес.
	DeliveryEnabled          *bool `gorm:"column:delivery_enabled;not null;default:false" json:"delivery_enabled"`
	DeliveryContactsRequired *bool `gorm:"column:delivery_contacts_required;not null;default:true" json:"delivery_contacts_required"`
	// MenuSortBySales — сортировать меню в POS/pos2 по продаваемости (окно 30
	// дней), хиты вверху категории. Default false → алфавит (060).
	MenuSortBySales *bool `gorm:"column:menu_sort_by_sales;not null;default:false" json:"menu_sort_by_sales"`
	// Табло выдачи /board (072). BoardStations — CSV станций для показа (как у
	// кухонного планшета); пусто/NULL = все. BoardLogoOpacity — яркость
	// логотипа-фона за «Готово», проценты 0–100; NULL = дефолт 13.
	BoardStations    *string   `gorm:"column:board_stations" json:"board_stations"`
	BoardLogoOpacity *int      `gorm:"column:board_logo_opacity" json:"board_logo_opacity"`
	CreatedAt        time.Time `json:"created_at"`
	UpdatedAt        time.Time `json:"updated_at"`
}

func (Restaurant) TableName() string { return "restaurants" }

// CompanyAccount — сеть филиалов (ADR-003). Группирует N ресторанов одного
// владельца под общим account_id (restaurants.account_id → company_accounts.id).
type CompanyAccount struct {
	ID        string  `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name      string  `gorm:"not null" json:"name"`
	OwnerName *string `gorm:"column:owner_name" json:"owner_name"`
	Phone     *string `json:"phone"`
	// PublicURL — публичный адрес central-узла (напр. https://central.example.com),
	// вводится один раз при генерации первого кода приглашения (ADR-003,
	// продолжение) и переиспользуется для следующих.
	PublicURL *string   `gorm:"column:public_url" json:"public_url,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (CompanyAccount) TableName() string { return "company_accounts" }

// Nomenclature — общий справочник продуктов сети (ADR-003, вариант 3B).
// Связывает «один и тот же продукт» между филиалами: ingredients.nomenclature_id
// → nomenclature.id. Остаток qty при этом остаётся в ingredients (пер-филиал).
type Nomenclature struct {
	ID        string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	AccountID *string   `gorm:"column:account_id;type:uuid;index" json:"account_id"`
	Name      string    `gorm:"not null" json:"name"`
	Unit      *string   `json:"unit"`
	Category  *string   `json:"category"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
	// DeletedAt — tombstone (миграция 081). Строка не удаляется физически:
	// down-sync устроен как insert-if-absent, и исчезнувшую строку филиал
	// просто сохранил бы навсегда. Помеченная — доезжает и несёт «записи
	// больше нет»; филиал по ней ОТВЯЗЫВАЕТ свой товар, не удаляя его.
	// Обычное gorm.DeletedAt НЕ используем: мягкое удаление здесь должно быть
	// видимым для синка (tombstone надо уметь ВЫБРАТЬ), а gorm.DeletedAt
	// незаметно прячет строки во всех запросах модели.
	DeletedAt *time.Time `gorm:"column:deleted_at" json:"deleted_at,omitempty"`
}

func (Nomenclature) TableName() string { return "nomenclature" }

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
	// Тип оплаты труда (054). monthly → начисление = Salary. daily →
	// DailyRate × число дней с отметкой в табеле за период. Дни не хранятся
	// отдельно: источник правды — time_entries, чтобы расчёт всегда сходился
	// с тем, что видно в табеле.
	PayType     *string         `gorm:"column:pay_type;not null;default:'monthly'" json:"pay_type"`
	DailyRate   decimal.Decimal `gorm:"column:daily_rate;type:numeric(14,4);not null;default:0" json:"daily_rate"`
	Advance     decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"advance"`
	Deductions  decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"deductions"`
	Permissions datatypes.JSON  `gorm:"type:jsonb" json:"permissions"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
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
