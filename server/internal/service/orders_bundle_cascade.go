package service

import (
	"time"

	"gorm.io/gorm"

	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// cascadeCancelBundleSiblings — при ПОЛНОЙ отмене компонента сета отменяет
// остальные order_items того же bundle_group_id (ещё не отменённые), чтобы
// деньги/кухонная «ОТМЕНА» не остались висеть на «половине» сета: без каскада
// картошка осталась бы в заказе (и на кухне её всё равно готовят), а деньги —
// числиться за бургером, который гость уже вернул.
//
// Вызывается ПОСЛЕ того, как caller уже отменил сам excludeItemID — эта
// функция только про СОСЕДЕЙ. Все компоненты сета создаются с qty=1 (см.
// expandBundleSelections в orders_write.go), поэтому здесь всегда full-cancel
// сиблингов — партиями сет не собирается и не разбирается.
//
// Возвращает отменённые строки (для runner «ОТМЕНА» на кухню, тем же путём,
// что и основная позиция) и суммарный line-total (для order.total/cancelled_total
// у caller'а — эта функция сама order НЕ трогает, только order_items).
func cascadeCancelBundleSiblings(
	tx *gorm.DB, orderID, bundleGroupID, excludeItemID, canceller, reason string, now time.Time,
) ([]models.OrderItem, decimal.Decimal, error) {
	var siblings []models.OrderItem
	if err := tx.Where("order_id = ? AND bundle_group_id = ? AND id <> ? AND cancelled_at IS NULL",
		orderID, bundleGroupID, excludeItemID).Find(&siblings).Error; err != nil {
		return nil, decimal.Zero, err
	}
	if len(siblings) == 0 {
		return nil, decimal.Zero, nil
	}
	total := decimal.Zero
	cascadeReason := "автоматически вместе с сетом: " + reason
	for i := range siblings {
		siblings[i].CancelledAt = &now
		siblings[i].CancelledBy = &canceller
		siblings[i].CancelReason = &cascadeReason
		siblings[i].UpdatedAt = now
		if err := tx.Save(&siblings[i]).Error; err != nil {
			return nil, decimal.Zero, err
		}
		eff := effectivePortions(siblings[i].Unit, siblings[i].Qty, siblings[i].UnitSize)
		total = decimal.Add(total, decimal.Mul(siblings[i].Price, eff))
	}
	return siblings, decimal.Normalize(total), nil
}
