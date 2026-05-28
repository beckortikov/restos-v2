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
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
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
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	ShiftID      *string         `gorm:"column:shift_id;index" json:"shift_id"`
	CreatedAt    time.Time       `json:"created_at"`
	UpdatedAt    time.Time       `json:"updated_at"`
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
	UpdatedAt      time.Time        `json:"updated_at"`
}

func (CashShift) TableName() string { return "cash_shifts" }

// CashShiftOperation — внутрисменная операция (внос/изъятие).
type CashShiftOperation struct {
	ID          string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	ShiftID     *string         `gorm:"column:shift_id;type:uuid;index" json:"shift_id"`
	Type        *string         `json:"type"`
	Amount      decimal.Decimal `gorm:"type:numeric(14,4);default:0" json:"amount"`
	Description *string         `json:"description"`
	CreatedBy   *string         `gorm:"column:created_by" json:"created_by"`
	CreatedAt   time.Time       `json:"created_at"`
	UpdatedAt   time.Time       `json:"updated_at"`
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
