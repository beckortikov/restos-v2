// Package synclog — запись дельт в sync_log для синхронизации филиал →
// центральный узел (Фаза 2 multi-branch, ADR-003).
//
// Режим «только нужное»: пишем не всё подряд, а точечно то, что реально нужно
// центральному узлу — документы перемещений (чтобы доезжали до филиала) и
// денежные операции (для сводки владельцу). Поэтому — явный Record в сервисах,
// а не generic-хук на все таблицы (который к тому же ненадёжен на Updates(map)).
package synclog

import (
	"encoding/json"
	"time"

	"github.com/google/uuid"
	"gorm.io/datatypes"
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
)

// Entry — одна дельта для журнала.
type Entry struct {
	Entity       string // имя таблицы (stock_transfers, financial_operations, …)
	RowID        string // PK изменённой строки
	Op           string // insert | update | delete
	RestaurantID *string
	AccountID    *string
	Payload      any // снимок строки (для upsert на центральном узле); может быть nil
}

// Record пишет дельту в sync_log в ПЕРЕДАННОЙ транзакции tx — атомарно с самой
// мутацией (откатится вместе с ней). synced_at остаётся NULL до отправки пушером.
func Record(tx *gorm.DB, e Entry) error {
	var pl datatypes.JSON
	if e.Payload != nil {
		b, err := json.Marshal(e.Payload)
		if err != nil {
			return err
		}
		pl = datatypes.JSON(b)
	}
	row := &models.SyncLog{
		ID:           uuid.NewString(),
		Entity:       e.Entity,
		RowID:        e.RowID,
		Op:           e.Op,
		RestaurantID: e.RestaurantID,
		AccountID:    e.AccountID,
		Payload:      pl,
		CreatedAt:    time.Now().UTC(),
	}
	// SkipHooks: не триггерим audit/stock хуки на служебную запись.
	return tx.Session(&gorm.Session{NewDB: true, SkipHooks: true}).Create(row).Error
}
