package models

import (
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// FinancialAccount — финансовый счёт (наличка/банк/...).
type FinancialAccount struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         *string         `json:"name"`
	Type         *string         `gorm:"default:'cash'" json:"type"`
	Balance      decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"balance"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	// IsEnabled — счёт предлагается при оплате и в операциях. Отключённый счёт
	// остаётся в системе со всей историей и остатком (см. миграцию 063), но
	// исчезает из пикеров, и сервер не даёт провести на него деньги.
	IsEnabled  bool       `gorm:"column:is_enabled;default:true" json:"is_enabled"`
	DisabledAt *time.Time `gorm:"column:disabled_at" json:"disabled_at,omitempty"`
	CreatedAt  time.Time  `json:"created_at"`
	UpdatedAt  time.Time  `json:"updated_at"`
}

func (FinancialAccount) TableName() string { return "financial_accounts" }

// FinancialOperation — приход/расход денег.
// Создаётся либо вручную (Manager), либо автоматически GORM-хуком при close_order.
type FinancialOperation struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Type         *string         `json:"type"`
	Amount       decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"amount"`
	Category     *string         `json:"category"`
	AccountID    *string         `gorm:"column:account_id" json:"account_id"`
	AccountName  *string         `gorm:"column:account_name" json:"account_name"`
	Activity     *string         `gorm:"default:'operational'" json:"activity"`
	Date         *string         `json:"date"`
	Description  *string         `json:"description"`
	Counterparty *string         `json:"counterparty"`
	IsAuto       *bool           `gorm:"column:is_auto;default:false" json:"is_auto"`
	SourceRef    *string         `gorm:"column:source_ref" json:"source_ref"`
	// SalaryPeriod — период начисления (YYYY-MM) зарплатной/авансовой
	// проводки (082). Источник истины для «выплачено за месяц X» — НЕ дата
	// проводки (зарплату часто платят в начале следующего месяца) и не тег
	// в Description (устарел вместе с этим полем, но продолжаем писать для
	// человекочитаемости ленты).
	SalaryPeriod *string `gorm:"column:salary_period" json:"salary_period,omitempty"`
	RestaurantID *string `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	ShiftID      *string `gorm:"column:shift_id;index" json:"shift_id"`
	// IsOverride — выплата ЗП/аванса/обслуживания выше расчётного остатка,
	// проведённая осознанно (владелец подтвердил + указал причину), а не
	// заблокированная сервером. См. миграцию 064 и SalaryService.payout.
	IsOverride bool `gorm:"column:is_override;default:false" json:"is_override"`
	// CancelledAt/CancelledBy — отмена выплаты (071): исходная проводка не
	// удаляется, а помечается отменённой (для «Отменено» в ленте + защита от
	// повторной отмены). Деньги возвращаются компенсирующей проводкой + на счёт.
	CancelledAt *time.Time `gorm:"column:cancelled_at" json:"cancelled_at"`
	CancelledBy *string    `gorm:"column:cancelled_by" json:"cancelled_by"`
	// TargetRestaurantID / PaidByRestaurantID — расход одного узла сети ЗА
	// другой (Фаза Р, миграция 079). Проставляется ровно одно из двух:
	// первое — на проводке плательщика («заплатил за филиал X», исключается из
	// ЕГО ОПиУ), второе — на зеркальной проводке филиала («за нас заплатил
	// узел Y», без счёта и без движения баланса, исключается из ЕГО ДДС и из
	// сетевого ДДС). Подробнее — в комментарии миграции.
	TargetRestaurantID *string `gorm:"column:target_restaurant_id;type:uuid" json:"target_restaurant_id,omitempty"`
	PaidByRestaurantID *string `gorm:"column:paid_by_restaurant_id;type:uuid" json:"paid_by_restaurant_id,omitempty"`
	// CreatedBy — кто провёл операцию (users.id актора, миграция 100). NULL у
	// строк без человека в контексте: репликация с филиала и фоновые джобы
	// (регулярные платежи по расписанию), а также у исторических операций, для
	// которых не нашлось create-записи в audit_log при бэкфилле.
	CreatedBy *string   `gorm:"column:created_by" json:"created_by,omitempty"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (FinancialOperation) TableName() string { return "financial_operations" }

// CashShift — кассовая смена.
type CashShift struct {
	ID             string           `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	OpenedBy       *string          `gorm:"column:opened_by" json:"opened_by"`
	ClosedBy       *string          `gorm:"column:closed_by" json:"closed_by"`
	OpeningBalance decimal.Decimal  `gorm:"column:opening_balance;type:numeric(14,4);default:0" json:"opening_balance"`
	ClosingBalance decimal.Decimal  `gorm:"column:closing_balance;type:numeric(14,4);default:0" json:"closing_balance"`
	ExpectedCash   *decimal.Decimal `gorm:"column:expected_cash;type:numeric(14,4)" json:"expected_cash"`
	CashRevenue    decimal.Decimal  `gorm:"column:cash_revenue;type:numeric(14,4);default:0" json:"cash_revenue"`
	CardRevenue    decimal.Decimal  `gorm:"column:card_revenue;type:numeric(14,4);default:0" json:"card_revenue"`
	OrdersCount    *int             `gorm:"column:orders_count;default:0" json:"orders_count"`
	AvgCheck       decimal.Decimal  `gorm:"column:avg_check;type:numeric(14,4);default:0" json:"avg_check"`
	Status         *string          `gorm:"default:'open'" json:"status"`
	OpenedAt       time.Time        `gorm:"column:opened_at" json:"opened_at"`
	ClosedAt       *time.Time       `gorm:"column:closed_at" json:"closed_at"`
	RestaurantID   *string          `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	AccountID      *string          `gorm:"column:account_id" json:"account_id"`
	// ClosedOpenOrdersCount — сколько заказов были ещё открыты в момент
	// закрытия ЭТОЙ смены (068). 0 — обычное закрытие. >0 — закрыли осознанно
	// (право shifts.close_with_open_orders + подтверждение с фронта), для
	// пометки в истории смен — см. миграцию 068 за подробностями.
	ClosedOpenOrdersCount int       `gorm:"column:closed_open_orders_count;default:0" json:"closed_open_orders_count"`
	UpdatedAt             time.Time `json:"updated_at"`
}

func (CashShift) TableName() string { return "cash_shifts" }

// CashShiftOperation — внутрисменная операция (внос/изъятие).
type CashShiftOperation struct {
	ID          string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	ShiftID     *string         `gorm:"column:shift_id;type:uuid;index" json:"shift_id"`
	Type        *string         `json:"type"`
	Amount      decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"amount"`
	Description *string         `json:"description"`
	// Category — категория расхода (Закупка/Зарплата/Хозтовары…). Заполнена
	// только для расходов (cash_out с категорией). NULL → изъятие/внесение.
	Category *string `json:"category"`
	// AccountID — счёт, с которого прошла операция. NULL → счёт смены (наличный
	// ящик, legacy). Не-NULL и ≠ счёту смены → безналичный расход: дебетует свой
	// счёт, но наличный ящик (expected_cash) не трогает — зеркалит приход, где
	// нал идёт на кассу, а карта на банк-счёт.
	AccountID *string `gorm:"column:account_id;type:uuid" json:"account_id"`
	// SourceRef — id financial_operations, отток которой отражает это
	// авто-зеркало (069). NULL — legacy/фантомное зеркало (поведение
	// удаления не меняется). Заполнен и запись ещё существует — зеркало
	// реальное и действующее, DeleteOperation/DeleteExpense блокируют прямое
	// удаление (см. миграцию 069 за подробностями про БАГ #28).
	SourceRef *string   `gorm:"column:source_ref" json:"source_ref"`
	CreatedBy *string   `gorm:"column:created_by" json:"created_by"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

func (CashShiftOperation) TableName() string { return "cash_shift_operations" }

// Asset — основные средства.
type Asset struct {
	ID               string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name             *string         `json:"name"`
	Category         *string         `json:"category"`
	Amount           decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"amount"`
	PurchaseDate     *string         `gorm:"column:purchase_date" json:"purchase_date"`
	UsefulLifeMonths *int            `gorm:"column:useful_life_months" json:"useful_life_months"`
	Note             *string         `json:"note"`
	RestaurantID     *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt        time.Time       `json:"created_at"`
	UpdatedAt        time.Time       `json:"updated_at"`
}

func (Asset) TableName() string { return "assets" }

// Liability — обязательства (кредиты, долги).
type Liability struct {
	ID              string           `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name            *string          `json:"name"`
	Category        *string          `json:"category"`
	TotalAmount     decimal.Decimal  `gorm:"column:total_amount;type:numeric(14,4);default:0" json:"total_amount"`
	PaidAmount      decimal.Decimal  `gorm:"column:paid_amount;type:numeric(14,4);default:0" json:"paid_amount"`
	RemainingAmount decimal.Decimal  `gorm:"column:remaining_amount;type:numeric(14,4);default:0" json:"remaining_amount"`
	Creditor        *string          `json:"creditor"`
	DueDate         *string          `gorm:"column:due_date" json:"due_date"`
	MonthlyPayment  decimal.Decimal  `gorm:"column:monthly_payment;type:numeric(14,4);default:0" json:"monthly_payment"`
	InterestRate    *decimal.Decimal `gorm:"column:interest_rate;type:numeric(14,4)" json:"interest_rate"`
	Note            *string          `json:"note"`
	RestaurantID    *string          `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt       time.Time        `json:"created_at"`
	UpdatedAt       time.Time        `json:"updated_at"`
}

func (Liability) TableName() string { return "liabilities" }

// EquityEntry — собственный капитал.
type EquityEntry struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         *string         `json:"name"`
	Category     *string         `json:"category"`
	Amount       decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"amount"`
	Note         *string         `json:"note"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

func (EquityEntry) TableName() string { return "equity_entries" }

// BudgetLine — плановые/фактические показатели бюджета.
type BudgetLine struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Category     *string         `json:"category"`
	Type         *string         `json:"type"`
	PlanAmount   decimal.Decimal `gorm:"column:plan_amount;type:numeric(14,4);default:0" json:"plan_amount"`
	FactAmount   decimal.Decimal `gorm:"column:fact_amount;type:numeric(14,4);default:0" json:"fact_amount"`
	Period       *string         `json:"period"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
}

func (BudgetLine) TableName() string { return "budget_lines" }

// RecurringPayment — шаблон повторяющегося платежа (аренда, коммуналка, оклад,
// долг долями). Не авто-списание: напоминает и подставляет сумму/счёт, деньги
// уходят по кнопке «Оплатить». next_due — следующая дата платежа, двигается на
// месяц вперёд, только когда оплата закрывает остаток текущего цикла целиком
// (см. RemainingAmount) — иначе платёж частичный, срок остаётся на месте.
type RecurringPayment struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         *string         `json:"name"`
	Category     *string         `json:"category"`
	Amount       decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"amount"`
	AccountID    *string         `gorm:"column:account_id" json:"account_id"`
	Activity     *string         `gorm:"default:'operational'" json:"activity"`
	Counterparty *string         `json:"counterparty"`
	DayOfMonth   int             `gorm:"column:day_of_month;default:1" json:"day_of_month"`
	NextDue      *string         `gorm:"column:next_due" json:"next_due"`
	LastPaidAt   *time.Time      `gorm:"column:last_paid_at" json:"last_paid_at"`
	// RemainingAmount — остаток ТЕКУЩЕГО цикла после частичной оплаты. NULL —
	// ничего не платили в этом цикле, к оплате вся Amount. Ставится в Pay():
	// пока остаток > 0, next_due не двигается — цикл считается незакрытым.
	RemainingAmount *decimal.Decimal `gorm:"column:remaining_amount;type:numeric(14,4)" json:"remaining_amount"`
	LastPaidAmount  *decimal.Decimal `gorm:"column:last_paid_amount;type:numeric(14,4)" json:"last_paid_amount"`
	Active          bool             `gorm:"default:true" json:"active"`
	Note            *string          `json:"note"`
	RestaurantID    *string          `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt       time.Time        `json:"created_at"`
	UpdatedAt       time.Time        `json:"updated_at"`
}

func (RecurringPayment) TableName() string { return "recurring_payments" }
