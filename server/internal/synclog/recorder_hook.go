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
//
// cash_shift_operations (Ф1, ADR-003 «Central видит всё») — тоже append-only
// (создаются только через tx.Create в AddOperation/recordShiftCashOutIfActive),
// поэтому годятся под тот же generic-хук. Удаление операции (DeleteExpense/
// DeleteOperation) хук не ловит — там explicit recordShiftOpDeleteSync.
//
// stock_movements (Ф3) — append-only событие (все 19 точек создания в service
// делают struct-based tx.Create, ни одна не использует Updates(map)) — тот же
// generic-хук покрывает продажу/списание/приёмку/инвентаризацию/перемещение/
// хозрасход/производство разом, без 19 явных вызовов. Денормализованный
// ingredients синкается ОТДЕЛЬНО, снапшотом, внутри самого денорм-хука
// (audit/stock_hook.go, после applyStockMovement с SkipHooks central его не
// повторяет — см. комментарий там).
//
// supply_expenses (Ф4) — единственная точка мутации (SupplyExpensesService.Create,
// stock_extra.go) создаёт строку через struct-based tx.Create и НИКОГДА её не
// обновляет/не удаляет (разведка: grep по всему service/ на Model(&SupplyExpense
// либо Delete(&SupplyExpense — ноль совпадений) — идеальный кандидат под
// generic-хук, явный recordXSync не нужен вовсе.
var trackedInsert = map[string]bool{
	"financial_operations":  true,
	"cash_shift_operations": true,
	"stock_movements":       true,
	"supply_expenses":       true,
}

// trackedSave (Ф5, ADR-003 «Central видит всё») — таблицы, у которых
// синкается И INSERT, И UPDATE. Первый (и единственный на сегодня) кандидат —
// financial_accounts: баланс счёта мутируется из ~20 разных мест по всему
// кодовому базу (оплата заказа/накладной/долга, выплата зарплаты, ручной
// перевод, коррекция...) — писать явный recordXSync на каждой точке (как
// Ф1-Ф4) означало бы 20 мест правки вместо одного хука, и любая НОВАЯ точка
// мутации в будущем молча выпадала бы из синка, пока кто-то не вспомнит про
// него руками. Отсюда — единственный случай в этом плане, где generic-хук
// оправдан несмотря на предупреждение в шапке recorder.go «ненадёжен на
// Updates(map)»: та ненадёжность решается перечиткой строки из БД ПОСЛЕ
// апдейта (afterUpdate ниже), а не попыткой прочитать финальное значение из
// самого Updates(map)/gorm.Expr(...) (что было бы и правда ненадёжно —
// 6 из 20 точек пишут через gorm.Expr, вычисляемое в БД, а не Go-значением).
//
// Ограничение: afterUpdate достаёт RowID через reflection на Statement.Model
// (см. SetupUpdateReflectValue в самом GORM, callbacks/update.go) — работает,
// только если ID реально заполнен в переданной .Model()-структуре. Голый
// литерал &models.FinancialAccount{} + отдельный .Where("id = ?", ...)
// (7 из 20 найденных точек так и делали) — точку не засинкает молча.
// Все 7 точек поправлены на &models.FinancialAccount{ID: x} (Ф5, см. git log).
// ЛЮБАЯ будущая новая точка мутации financial_accounts ОБЯЗАНА повторить этот
// паттерн — иначе баланс на central тихо перестанет обновляться для неё.
var trackedSave = map[string]bool{
	"financial_accounts": true,
}

// RegisterRecorder цепляет AfterCreate+AfterUpdate хуки, пишущие дельты
// tracked-таблиц в sync_log. Регистрируется один раз в db.Open. No-op пока
// SetEnabled(false).
func RegisterRecorder(db *gorm.DB) error {
	if err := db.Callback().Create().After("gorm:create").Register("synclog:after_create", afterCreate); err != nil {
		return err
	}
	return db.Callback().Update().After("gorm:update").Register("synclog:after_update", afterUpdate)
}

func afterCreate(tx *gorm.DB) {
	if !enabled.Load() {
		return
	}
	if tx.Error != nil || tx.DryRun || tx.Statement == nil || tx.Statement.Dest == nil {
		return
	}
	if !trackedInsert[tx.Statement.Table] && !trackedSave[tx.Statement.Table] {
		return
	}
	rows := buildRows(tx.Statement.Table, tx.Statement.Dest, "insert")
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

// afterUpdate (Ф5) — для trackedSave-таблиц перечитывает строку из БД ПОСЛЕ
// апдейта и синкает её как снапшот (Op:"update"). Не пытается построить
// payload из Statement.Dest (это карта апдейта, не финальная строка — см.
// комментарий у trackedSave) — вместо этого достаёт RowID через reflection
// на Statement.Model (GORM's SetupUpdateReflectValue уже выставил его к этому
// моменту цепочки колбэков) и делает свежий SELECT.
func afterUpdate(tx *gorm.DB) {
	if !enabled.Load() {
		return
	}
	if tx.Error != nil || tx.DryRun || tx.Statement == nil || tx.Statement.Schema == nil {
		return
	}
	if !trackedSave[tx.Statement.Table] {
		return
	}
	id := readStringField(tx.Statement.ReflectValue, "ID")
	if id == "" {
		// Голый литерал без ID (см. комментарий у trackedSave) — эта точка
		// мутации не будет засинкана. Не паникуем и не логируем как ошибку:
		// на момент написания все известные точки уже поправлены, но новый
		// код мог случайно повторить старый паттерн — тихий пропуск лучше,
		// чем спам в лог на каждый обычный запрос.
		return
	}
	fresh := reflect.New(tx.Statement.Schema.ModelType).Interface()
	sess := tx.Session(&gorm.Session{NewDB: true, SkipHooks: true})
	if err := sess.Where("id = ?", id).First(fresh).Error; err != nil {
		log.Error().Err(err).Str("table", tx.Statement.Table).Str("id", id).
			Msg("synclog recorder hook: reload after update failed")
		return
	}
	rows := buildRows(tx.Statement.Table, fresh, "update")
	if len(rows) == 0 {
		return
	}
	for _, r := range rows {
		if err := sess.Create(r).Error; err != nil {
			log.Error().Err(err).Str("table", tx.Statement.Table).Msg("synclog recorder hook: update-insert failed")
		}
	}
}

// buildRows делает []*SyncLog из dest (структура или срез структур).
func buildRows(table string, dest any, op string) []*models.SyncLog {
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
			if r := buildRow(table, v.Index(i), op, now); r != nil {
				out = append(out, r)
			}
		}
		return out
	case reflect.Struct:
		if r := buildRow(table, v, op, now); r != nil {
			return []*models.SyncLog{r}
		}
	}
	return nil
}

func buildRow(table string, v reflect.Value, op string, now time.Time) *models.SyncLog {
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
		Op:           op,
		RestaurantID: rid,
		Payload:      pl,
		CreatedAt:    now,
	}
}

func readStringField(v reflect.Value, field string) string {
	if v.Kind() != reflect.Struct {
		// afterUpdate передаёт сюда tx.Statement.ReflectValue напрямую (не
		// прошедшее через тот же цикл дедереференса, что buildRow делает для
		// v перед вызовом этой функции) — защита от паники FieldByName на
		// невалидном/не-struct Value, если Model в конкретном апдейте не был
		// структурой (не должно происходить для trackedSave-таблиц при
		// текущих вызывающих, но лучше тихо вернуть "", чем упасть).
		return ""
	}
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
