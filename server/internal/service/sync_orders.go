package service

import (
	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/synclog"
)

// orderSyncPayload — снимок заказа + его позиций для sync_log (multi-branch
// сеть, ADR-003 Фаза 5). Отдельный тип, а не поле на models.Order: Order
// используется «голой» структурой в десятках обычных JSON-ответов API, добавлять
// туда постороннее Items ради одного sync-пути протекло бы во все них.
type orderSyncPayload struct {
	models.Order
	Items []models.OrderItem `json:"items"`
}

// recordOrderSync пишет дельту заказа в sync_log — ТОЛЬКО из терминальных точек
// его жизненного цикла (Close/Cancel/VoidItem-auto-cancel/Refund), не на каждое
// промежуточное изменение (new→cooking→ready→served). Ни один отчёт (P&L,
// аналитика) не читает промежуточные статусы — только closed/cancelled/refunded,
// реплицировать остальное было бы чистым шумом.
//
// Вызывается из ТОЙ ЖЕ транзакции, что и сама мутация заказа, СРАЗУ ПОСЛЕ
// tx.Save(&order) — order_items к этому моменту уже стабильны (не мутируются
// дальше в Close/Cancel/Refund), поэтому свежий SELECT их здесь безопасен и
// видит все правки этой же транзакции (Postgres read-your-own-writes).
func recordOrderSync(tx *gorm.DB, order *models.Order, op string) error {
	var items []models.OrderItem
	if err := tx.Where("order_id = ?", order.ID).Find(&items).Error; err != nil {
		return err
	}
	return synclog.Record(tx, synclog.Entry{
		Entity:       "orders",
		RowID:        order.ID,
		Op:           op,
		RestaurantID: order.RestaurantID,
		Payload:      orderSyncPayload{Order: *order, Items: items},
	})
}
