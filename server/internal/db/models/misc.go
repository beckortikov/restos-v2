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
	// Source — откуда отметка (101): manual (веб-табель) | app (терминал
	// :checkin) | hikvision (СКУД, коннектор впереди). Указатель, а не
	// строка: у GORM zero-значение "" затирало бы дефолт колонки на
	// Create — та же грабля, что с bool-полями и default-тегом.
	Source       *string   `gorm:"column:source;default:'manual'" json:"source,omitempty"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	CreatedAt    time.Time `json:"created_at"`
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

// ShiftScheduleTemplate — обычная неделя сотрудника (102): одна строка на день
// недели, нет строки — в этот день не работает. Weekday в ISO-нумерации
// (1=пн … 7=вс), чтобы совпадать с EXTRACT(ISODOW) и не сдвигаться на единицу.
type ShiftScheduleTemplate struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	UserID       *string   `gorm:"column:user_id;type:uuid" json:"user_id"`
	Weekday      int       `gorm:"column:weekday" json:"weekday"`
	StartsAt     string    `gorm:"column:starts_at" json:"starts_at"` // 'HH:MM' локального времени
	EndsAt       string    `gorm:"column:ends_at" json:"ends_at"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (ShiftScheduleTemplate) TableName() string { return "shift_schedule_templates" }

// ShiftScheduleDay — переопределение графика на конкретную дату (102):
// подмена, отгул, разовая смена. Перебивает шаблон. Kind='off' — явный
// выходной вопреки шаблону; без него отгул неотличим от незаполненного
// графика.
type ShiftScheduleDay struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	UserID       *string   `gorm:"column:user_id;type:uuid" json:"user_id"`
	WorkDate     string    `gorm:"column:work_date;type:date" json:"work_date"` // YYYY-MM-DD
	Kind         string    `gorm:"column:kind" json:"kind"`                     // work | off
	StartsAt     *string   `gorm:"column:starts_at" json:"starts_at,omitempty"`
	EndsAt       *string   `gorm:"column:ends_at" json:"ends_at,omitempty"`
	Note         *string   `gorm:"column:note" json:"note,omitempty"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (ShiftScheduleDay) TableName() string { return "shift_schedule_days" }

// AttendancePhoto — селфи при отметке (103). Оригинал лежит файлом на диске
// филиала (Path), в БД только превью (Thumb) — оно уезжает в центр синком, а
// оригинал остаётся на филиале: см. комментарий миграции.
type AttendancePhoto struct {
	ID           string    `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID *string   `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	EntryID      string    `gorm:"column:entry_id;type:uuid" json:"entry_id"`
	UserID       *string   `gorm:"column:user_id;type:uuid" json:"user_id"`
	Kind         string    `gorm:"column:kind" json:"kind"` // in | out
	TakenAt      time.Time `gorm:"column:taken_at" json:"taken_at"`
	// Path — путь ОТНОСИТЕЛЬНО каталога фото ('2026-09/<id>.jpg'), не
	// абсолютный: data-dir у кассы и у центра разные, а абсолютный путь с
	// чужой машины в реплике был бы мусором.
	Path      *string   `gorm:"column:path" json:"path,omitempty"`
	Thumb     []byte    `gorm:"column:thumb" json:"thumb,omitempty"`
	CreatedAt time.Time `json:"created_at"`
}

func (AttendancePhoto) TableName() string { return "attendance_photos" }

// TimesheetApproval — снимок табеля за период по одному сотруднику (106).
//
// Accrued хранится снимком, хотя его можно пересчитать: правило начисления со
// временем меняется (подняли ставку, сменили тип оплаты), и пересчёт старого
// периода по новым правилам дал бы сумму, которой никогда не выплачивали.
type TimesheetApproval struct {
	ID             string          `gorm:"primaryKey;type:uuid;default:gen_random_uuid()" json:"id"`
	RestaurantID   *string         `gorm:"column:restaurant_id;index" json:"restaurant_id"`
	PeriodFrom     string          `gorm:"column:period_from;type:date" json:"period_from"`
	PeriodTo       string          `gorm:"column:period_to;type:date" json:"period_to"`
	UserID         string          `gorm:"column:user_id;type:uuid" json:"user_id"`
	Days           int             `gorm:"column:days" json:"days"`
	Hours          decimal.Decimal `gorm:"column:hours;type:numeric(14,4)" json:"hours"`
	Accrued        decimal.Decimal `gorm:"column:accrued;type:numeric(14,4)" json:"accrued"`
	ApprovedAt     time.Time       `gorm:"column:approved_at" json:"approved_at"`
	ApprovedBy     *string         `gorm:"column:approved_by;type:uuid" json:"approved_by,omitempty"`
	ApprovedByName *string         `gorm:"column:approved_by_name" json:"approved_by_name,omitempty"`
	CancelledAt    *time.Time      `gorm:"column:cancelled_at" json:"cancelled_at,omitempty"`
	CancelledBy    *string         `gorm:"column:cancelled_by;type:uuid" json:"cancelled_by,omitempty"`
	CreatedAt      time.Time       `json:"created_at"`
	UpdatedAt      time.Time       `json:"updated_at"`
}

func (TimesheetApproval) TableName() string { return "timesheet_approvals" }

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
	Period *string `json:"period"`
	// SourceRef — откуда взялось удержание (105). Для штрафа за опоздание
	// это 'late:<user_id>:<дата>'; уникальный индекс по нему не даёт
	// оштрафовать дважды за один день. NULL у ручных удержаний.
	SourceRef   *string    `gorm:"column:source_ref" json:"source_ref,omitempty"`
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
	// вернуть деньги. NULL — аванс выдан ДРУГИМ узлом сети (центром, Ф-С5):
	// деньги списаны там, локальная отмена запрещена гвардом.
	AccountID *string `gorm:"column:account_id;type:uuid" json:"account_id"`
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
