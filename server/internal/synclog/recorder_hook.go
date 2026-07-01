package synclog

import (
	"encoding/json"
	"reflect"
	"time"

	"github.com/google/uuid"
	"github.com/rs/zerolog/log"
	"gorm.io/datatypes"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// trackedInsert — таблицы, INSERT'ы которых пишем в sync_log хуком (режим
// «только нужное»). Финопы — для сводки владельцу (выручка/расходы по сети).
// Они append-only и создаются структурами, поэтому AfterCreate-хук надёжен
// (в отличие от Updates(map)). Перемещения пишутся явно в сервисе.
var trackedInsert = map[string]bool{
	"financial_operations": true,
}

// RegisterRecorder цепляет AfterCreate-хук, пишущий дельты tracked-таблиц в
// sync_log. Регистрируется один раз в db.Open. No-op пока SetEnabled(false).
func RegisterRecorder(db *gorm.DB) error {
	return db.Callback().Create().After("gorm:create").Register("synclog:after_create", afterCreate)
}

func afterCreate(tx *gorm.DB) {
	if !enabled.Load() {
		return
	}
	if tx.Error != nil || tx.DryRun || tx.Statement == nil || tx.Statement.Dest == nil {
		return
	}
	if !trackedInsert[tx.Statement.Table] {
		return
	}
	rows := buildRows(tx.Statement.Table, tx.Statement.Dest)
	if len(rows) == 0 {
		return
	}
	// SkipHooks: не рекурсим и не аудируем служебную запись.
	sess := tx.Session(&gorm.Session{NewDB: true, SkipHooks: true})
	for _, r := range rows {
		if err := sess.Create(r).Error; err != nil {
			log.Error().Err(err).Str("table", tx.Statement.Table).Msg("synclog recorder hook: insert failed")
		}
	}
}

// buildRows делает []*SyncLog из Dest (структура или срез структур).
func buildRows(table string, dest any) []*models.SyncLog {
	v := reflect.ValueOf(dest)
	for v.Kind() == reflect.Pointer || v.Kind() == reflect.Interface {
		if v.IsNil() {
			return nil
		}
		v = v.Elem()
	}
	now := time.Now().UTC()
	switch v.Kind() {
	case reflect.Slice, reflect.Array:
		out := make([]*models.SyncLog, 0, v.Len())
		for i := 0; i < v.Len(); i++ {
			if r := buildRow(table, v.Index(i), now); r != nil {
				out = append(out, r)
			}
		}
		return out
	case reflect.Struct:
		if r := buildRow(table, v, now); r != nil {
			return []*models.SyncLog{r}
		}
	}
	return nil
}

func buildRow(table string, v reflect.Value, now time.Time) *models.SyncLog {
	for v.Kind() == reflect.Pointer {
		if v.IsNil() {
			return nil
		}
		v = v.Elem()
	}
	if v.Kind() != reflect.Struct {
		return nil
	}
	id := readStringField(v, "ID")
	if id == "" {
		return nil
	}
	var rid *string
	if s := readStringField(v, "RestaurantID"); s != "" {
		rid = &s
	}
	var pl datatypes.JSON
	if b, err := json.Marshal(v.Interface()); err == nil {
		pl = datatypes.JSON(b)
	}
	return &models.SyncLog{
		ID:           uuid.NewString(),
		Entity:       table,
		RowID:        id,
		Op:           "insert",
		RestaurantID: rid,
		Payload:      pl,
		CreatedAt:    now,
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
