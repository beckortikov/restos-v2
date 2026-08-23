package models

import (
	"time"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Customer — клиент (для CRM/программ лояльности).
type Customer struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Name         *string         `json:"name"`
	Phone        *string         `json:"phone"`
	Email        *string         `json:"email"`
	BirthDate    *string         `gorm:"column:birth_date" json:"birth_date"`
	Notes        *string         `json:"notes"`
	VisitsCount  *int            `gorm:"column:visits_count;default:0" json:"visits_count"`
	TotalSpent   decimal.Decimal `gorm:"column:total_spent;type:numeric(14,4);default:0" json:"total_spent"`
	AvgCheck     decimal.Decimal `gorm:"column:avg_check;type:numeric(14,4);default:0" json:"avg_check"`
	LastVisitAt  *time.Time      `gorm:"column:last_visit_at" json:"last_visit_at"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
}

func (Customer) TableName() string { return "customers" }

// TimeEntry — учёт рабочего времени (clock_in/out).
type TimeEntry struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	UserID       *string         `gorm:"column:user_id;type:uuid" json:"user_id"`
	ClockIn      *time.Time      `gorm:"column:clock_in" json:"clock_in"`
	ClockOut     *time.Time      `gorm:"column:clock_out" json:"clock_out"`
	BreakMinutes *int            `gorm:"column:break_minutes;default:0" json:"break_minutes"`
	TotalHours   decimal.Decimal `gorm:"column:total_hours;type:numeric(14,4);default:0" json:"total_hours"`
	Status       *string         `gorm:"default:'active'" json:"status"`
	Note         *string         `json:"note"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time       `json:"created_at"`
	// UserName — НЕ колонка (gorm:"-"), проставляется вручную в
	// TimeEntriesService.List/ClockIn/ClockOut (JOIN-по-карте, не SQL JOIN —
	// см. комментарий там). Без имени табель показывал «Неизвестно» на
	// каждой строке и в «Кто на смене».
	UserName *string `gorm:"-" json:"user_name,omitempty"`
}

// SalaryWorkedDay — ручная отметка отработанного дня для дневной оплаты (059).
// Отдельно от табеля: начисление дневника = уникальные дни (табель ∪ отметки).
type SalaryWorkedDay struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	UserID       *string   `gorm:"column:user_id;type:uuid" json:"user_id"`
	WorkDate     string    `gorm:"column:work_date;type:date" json:"work_date"` // YYYY-MM-DD
	CreatedAt    time.Time `json:"created_at"`
}

func (SalaryWorkedDay) TableName() string { return "salary_worked_days" }

// SalaryDayMultiplier — множитель дневной оплаты за конкретный день (066):
// «две смены в один день» — строка существует, только когда множитель != 1
// (по умолчанию день = ×1, строки нет — как и SalaryWorkedDay, чистый override).
type SalaryDayMultiplier struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	UserID       *string   `gorm:"column:user_id;type:uuid" json:"user_id"`
	WorkDate     string    `gorm:"column:work_date;type:date" json:"work_date"` // YYYY-MM-DD
	Multiplier   int       `gorm:"column:multiplier;default:2" json:"multiplier"`
	CreatedAt    time.Time `json:"created_at"`
}

func (SalaryDayMultiplier) TableName() string { return "salary_day_multipliers" }

// SalaryDeduction — удержание из зарплаты с сохранённой причиной (064).
//
// НЕ FinancialOperation: удержание не двигает баланс счёта — деньги не
// выданы, им неоткуда "выходить". Это только уменьшение будущей выплаты
// (users.deductions), а причина раньше терялась в тосте сразу после ввода.
//
// Period/CancelledAt/CancelledBy — 070: привязка к месяцу и отмена (раньше
// удержание нельзя было ни к месяцу привязать, ни снять — DELETE для него не
// существовал вовсе).
type SalaryDeduction struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	UserID       string          `gorm:"column:user_id;type:uuid;index" json:"user_id"`
	Amount       decimal.Decimal `gorm:"type:numeric(14,4)" json:"amount"`
	Reason       string          `json:"reason"`
	// Period — YYYY-MM, к какому месяцу относится удержание. Пусто у записей
	// до 070 (миграция не бэкфиллит — они и раньше не были period-aware).
	Period      *string    `json:"period"`
	CreatedBy   *string    `gorm:"column:created_by" json:"created_by"`
	CreatedAt   time.Time  `json:"created_at"`
	CancelledAt *time.Time `gorm:"column:cancelled_at" json:"cancelled_at"`
	CancelledBy *string    `gorm:"column:cancelled_by" json:"cancelled_by"`
}

func (SalaryDeduction) TableName() string { return "salary_deductions" }

// SalaryAdvance — выдача аванса с сохранённой историей (070).
//
// ДО этой миграции "аванс" был сырым счётчиком users.advance, который менялся
// ДВУМЯ независимыми запросами подряд (выплата + отдельный PATCH нового
// значения) — если второй не проходил, деньги уходили, а счётчик не
// обновлялся, и поправить было нечего: без id нет что редактировать/отменять.
// Теперь выдача — ОДНА транзакция (создание этой строки + financial_operation
// + инкремент users.advance, см. SalaryService.GiveAdvance), и у записи есть
// id — можно отменить (CancelAdvance: реверс денег на AccountID + декремент
// счётчика), не трогая формулу капа выплаты (она по-прежнему читает
// users.advance — тот всегда синхронен с активными записями).
type SalaryAdvance struct {
	ID           string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	UserID       string          `gorm:"column:user_id;type:uuid;index" json:"user_id"`
	Amount       decimal.Decimal `gorm:"type:numeric(14,4)" json:"amount"`
	Period       string          `json:"period"`
	// AccountID — счёт, с которого выдан аванс. Нужен для отмены: куда
	// вернуть деньги.
	AccountID string  `gorm:"column:account_id;type:uuid" json:"account_id"`
	Note      *string `json:"note"`
	// SourceOpID — id financial_operations самой выплаты (для трассировки
	// «эта проводка — вот эта строка истории»).
	SourceOpID  *string    `gorm:"column:source_op_id;type:uuid" json:"source_op_id"`
	CreatedBy   *string    `gorm:"column:created_by" json:"created_by"`
	CreatedAt   time.Time  `json:"created_at"`
	CancelledAt *time.Time `gorm:"column:cancelled_at" json:"cancelled_at"`
	CancelledBy *string    `gorm:"column:cancelled_by" json:"cancelled_by"`
}

func (SalaryAdvance) TableName() string { return "salary_advances" }

func (TimeEntry) TableName() string { return "time_entries" }

// IdempotencyKey — кэш ответов для Idempotency-Key middleware.
//
// response_body — bytea, а не jsonb (см. миграцию 003): jsonb пересортирует
// ключи при roundtrip, что ломает байт-точный replay.
type IdempotencyKey struct {
	Key            string    `gorm:"primaryKey;type:uuid" json:"key"`
	Method         string    `gorm:"not null" json:"method"`
	Path           string    `gorm:"not null" json:"path"`
	RequestHash    string    `gorm:"column:request_hash;not null" json:"request_hash"`
	ResponseStatus int       `gorm:"column:response_status;not null" json:"response_status"`
	ResponseBody   []byte    `gorm:"column:response_body;type:bytea" json:"response_body"`
	RestaurantID   *string   `gorm:"column:restaurant_id" json:"restaurant_id"`
	UserID         *string   `gorm:"column:user_id" json:"user_id"`
	CreatedAt      time.Time `gorm:"not null" json:"created_at"`
	ExpiresAt      time.Time `gorm:"column:expires_at;not null;index" json:"expires_at"`
}

func (IdempotencyKey) TableName() string { return "idempotency_keys" }

// PrintJob — задача в очереди печати.
// status: pending | running | done | failed.
type PrintJob struct {
	ID           string     `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	Type         string     `gorm:"not null" json:"type"`
	PrinterID    *string    `gorm:"column:printer_id" json:"printer_id"`
	Payload      []byte     `gorm:"type:bytea;not null" json:"payload"`
	OrderID      *string    `gorm:"column:order_id;type:uuid" json:"order_id"`
	Status       string     `gorm:"not null;default:'pending'" json:"status"`
	Attempts     int        `gorm:"not null;default:0" json:"attempts"`
	LastError    *string    `gorm:"column:last_error" json:"last_error"`
	RestaurantID *string    `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time  `gorm:"not null" json:"created_at"`
	UpdatedAt    time.Time  `gorm:"not null" json:"updated_at"`
	PrintedAt    *time.Time `gorm:"column:printed_at" json:"printed_at"`
}

func (PrintJob) TableName() string { return "print_jobs" }
