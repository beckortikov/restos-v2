package audit

import (
	"encoding/json"
	"reflect"
	"strings"
	"time"

	"github.com/rs/zerolog/log"
	"gorm.io/datatypes"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// skipTables — таблицы, мутации которых не пишутся в audit_log.
var skipTables = map[string]bool{
	"audit_log":        true, // петля
	"idempotency_keys": true, // cache, не доменные данные
	"print_jobs":       true, // служебная очередь
}

// Register цепляет хуки на gorm.DB. Вызывается ОДИН раз при инициализации БД
// (после Open, до начала обслуживания запросов).
//
// Регистрируем три callback'а: после create / update / delete. Все три пишут
// одну запись в audit_log в ТОЙ ЖЕ транзакции, в которой произошла мутация —
// если транзакция откатится, лог тоже не сохранится. Это нужное поведение.
func Register(db *gorm.DB) error {
	if err := db.Callback().Create().After("gorm:create").Register("audit:after_create", makeHook("create")); err != nil {
		return err
	}
	if err := db.Callback().Update().After("gorm:update").Register("audit:after_update", makeHook("update")); err != nil {
		return err
	}
	if err := db.Callback().Delete().After("gorm:delete").Register("audit:after_delete", makeHook("delete")); err != nil {
		return err
	}
	return nil
}

func makeHook(action string) func(*gorm.DB) {
	return func(tx *gorm.DB) {
		// Игнорируем ошибочные мутации (gorm не дёргает After-хуки если был
		// Error до этого, но на всякий случай).
		if tx.Error != nil {
			return
		}
		// tx.Statement.Table — fallback, если модель не определена напрямую.
		table := tx.Statement.Table
		if skipTables[table] {
			return
		}
		// Пропускаем DryRun и записи без модели (Raw SQL).
		if tx.DryRun || tx.Statement.Model == nil {
			return
		}
		entry := buildEntry(tx, action, table)
		if entry == nil {
			return
		}
		// Пишем в той же транзакции, но в новом Statement.
		// NewDB=true даёт чистый Statement, при этом транзакция (ConnPool из tx)
		// остаётся той же — GORM это гарантирует. SkipHooks отключает наш же
		// callback, чтобы не было рекурсии (audit_log в skipTables, но
		// SkipHooks — дешевле и явнее).
		if err := tx.Session(&gorm.Session{NewDB: true, SkipHooks: true}).
			Create(entry).Error; err != nil {
			log.Error().Err(err).Str("table", table).Msg("audit hook: insert failed")
		}
	}
}

// buildEntry собирает запись audit_log из обработанной мутации.
// Возвращает nil, если запись не нужна (не получилось извлечь id).
func buildEntry(tx *gorm.DB, action, table string) *models.AuditLog {
	actor, _ := ActorFromContext(tx.Statement.Context)

	var (
		entityID   *string
		entityName *string
		restID     *string
	)

	// tx.Statement.Dest — обычно структура или []структура.
	dest := tx.Statement.Dest
	if dest != nil {
		if id, name, rid := extractFromValue(reflect.ValueOf(dest)); id != "" {
			s := id
			entityID = &s
			if name != "" {
				s := name
				entityName = &s
			}
			if rid != "" {
				s := rid
				restID = &s
			}
		}
	}

	now := time.Now().UTC()
	entry := &models.AuditLog{
		Action:       strPtr(action),
		EntityType:   strPtr(strings.TrimSuffix(table, "s")), // лёгкое нормирование
		EntityID:     entityID,
		EntityName:   entityName,
		RestaurantID: restID,
		CreatedAt:    now,
	}
	if actor.UserID != "" {
		s := actor.UserID
		entry.UserID = &s
	}
	if actor.UserName != "" {
		s := actor.UserName
		entry.UserName = &s
	}

	// Опциональный snapshot полей. Не сохраняем целиком (PII/печать etc) — кладём
	// только id+table_name. Полноценный snapshot — отдельная фича, добавим если
	// потребуется compliance.
	if d, err := json.Marshal(map[string]any{"table": table}); err == nil {
		entry.Details = datatypes.JSON(d)
	}
	return entry
}

// extractFromValue достаёт ID/Name/RestaurantID из любой структуры через рефлексию.
// Дёшево, но не быстро — допустимо для аудита (write-path).
func extractFromValue(v reflect.Value) (id, name, restID string) {
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return
		}
		v = v.Elem()
	}
	switch v.Kind() {
	case reflect.Slice, reflect.Array:
		if v.Len() == 0 {
			return
		}
		return extractFromValue(v.Index(0))
	case reflect.Struct:
		id = readStringField(v, "ID")
		name = readStringField(v, "Name")
		restID = readStringField(v, "RestaurantID")
		return
	default:
		return
	}
}

func readStringField(v reflect.Value, field string) string {
	f := v.FieldByName(field)
	if !f.IsValid() {
		return ""
	}
	for f.Kind() == reflect.Pointer {
		if f.IsNil() {
			return ""
		}
		f = f.Elem()
	}
	if f.Kind() == reflect.String {
		return f.String()
	}
	return ""
}

func strPtr(s string) *string { return &s }
