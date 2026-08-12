package service

import (
	"github.com/restos/restos-v4/server/internal/db/models"
	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// printGroup — одна строка для печати/отображения после группировки одинаковых
// порций. Для весовых блюд несколько одинаковых порций («3 по 100г») сливаются
// в одну строку с Count=3, чтобы чек/кухня не были длинными.
type printGroup struct {
	Name      string
	Price     decimal.Decimal
	Note      string
	Qty       decimal.Decimal // вес/кол-во ОДНОЙ порции
	Unit      string          // piece|g|kg
	UnitSize  decimal.Decimal
	Count     int             // сколько одинаковых порций слито
	LineTotal decimal.Decimal // суммарная стоимость группы (Count × per-portion)
	// BundleGroupID/BundleSlotLabel — сет (миграция 073): компоненты одного
	// добавления сета в заказ печатаются вместе под заголовком «Сет» (см.
	// escpos.ReceiptItem + buildReceipt). BundleGroupID — часть ключа слияния
	// ниже: без этого одинаковая «Кола» из ДВУХ разных сетов (или сета и
	// обычной продажи) слилась бы в одну строку «Кола x2», потеряв привязку
	// к своему сету — тот же класс бага, что уже правился на фронте
	// (groupWeightPortions/lib/receipt-data.ts).
	BundleGroupID   string
	BundleSlotLabel string
}

// groupPrintItems сливает одинаковые позиции в одну строку печати.
//
// Весовые (g/kg): одинаковые порции → одна строка с Count («100г × 3»). Разный
// вес не сливается — 100г и 150г это разные порции.
//
// Штучные (piece): одинаковые строки → одна с СУММОЙ qty («×2»). Раньше они не
// группировались вовсе, с обоснованием «и так уже одна строка с нужным qty» —
// но это неверно: касса создаёт отдельный order_item на каждое добавление, и
// «Фри Маленький», добавленный дважды, печатался кухне двумя строками «x1»
// вместо одной «x2». Повар считает порции по строкам и легко ошибается.
//
// Именно СУММА qty, а не Count: у штучных qty и есть количество, и чек печатает
// «Название qty». Через Count вышло бы «Фри Маленький x1 × 2» — арифметика
// верная, читается как ребус.
//
// Порядок первого появления сохраняется. LineTotal суммируется из per-row
// значений (price × qty) — логика цен НЕ меняется, просто строк меньше.
func groupPrintItems(items []models.OrderItem) []printGroup {
	out := make([]printGroup, 0, len(items))
	idx := map[string]int{}
	for _, it := range items {
		name := ""
		if it.Name != nil {
			name = *it.Name
		}
		note := ""
		if it.Note != nil {
			note = *it.Note
		}
		unit := "piece"
		if it.Unit != nil && *it.Unit != "" {
			unit = *it.Unit
		}
		bundleGroupID := ""
		if it.BundleGroupID != nil {
			bundleGroupID = *it.BundleGroupID
		}
		bundleSlotLabel := ""
		if it.BundleSlotLabel != nil {
			bundleSlotLabel = *it.BundleSlotLabel
		}
		lineTotal := decimal.Normalize(decimal.Mul(it.Price, effectivePortions(it.Unit, it.Qty, it.UnitSize)))
		isWeight := unit == "g" || unit == "kg"
		if isWeight {
			// Вес + bundleGroupID входят в ключ: 100г и 150г — разные порции;
			// одинаковый весовой компонент из ДВУХ разных сетов — тоже разные
			// строки (иначе один сет теряется в чужом заголовке «Сет»).
			key := name + "|" + it.Price.String() + "|" + note + "|" + it.Qty.String() + "|" + unit + "|" + bundleGroupID
			if i, ok := idx[key]; ok {
				out[i].Count++
				out[i].LineTotal = decimal.Normalize(decimal.Add(out[i].LineTotal, lineTotal))
				continue
			}
			idx[key] = len(out)
		} else {
			// Штучные: qty в ключ НЕ входит — «x1» и «x3» одного блюда должны
			// схлопнуться в «x4», а не остаться двумя строками. bundleGroupID —
			// входит: два сета с одинаковой «Колой» не должны слиться в «x2»
			// под ОДНИМ заголовком «Сет» (потеряется, что это два разных сета).
			key := name + "|" + it.Price.String() + "|" + note + "|" + unit + "|" + bundleGroupID
			if i, ok := idx[key]; ok {
				out[i].Qty = decimal.Normalize(decimal.Add(out[i].Qty, it.Qty))
				out[i].LineTotal = decimal.Normalize(decimal.Add(out[i].LineTotal, lineTotal))
				continue
			}
			idx[key] = len(out)
		}
		out = append(out, printGroup{
			Name:            name,
			Price:           it.Price,
			Note:            note,
			Qty:             it.Qty,
			Unit:            unit,
			UnitSize:        it.UnitSize,
			Count:           1,
			LineTotal:       lineTotal,
			BundleGroupID:   bundleGroupID,
			BundleSlotLabel: bundleSlotLabel,
		})
	}
	return out
}
