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
		lineTotal := decimal.Normalize(decimal.Mul(it.Price, effectivePortions(it.Unit, it.Qty, it.UnitSize)))
		isWeight := unit == "g" || unit == "kg"
		if isWeight {
			// Вес входит в ключ: 100г и 150г — разные порции.
			key := name + "|" + it.Price.String() + "|" + note + "|" + it.Qty.String() + "|" + unit
			if i, ok := idx[key]; ok {
				out[i].Count++
				out[i].LineTotal = decimal.Normalize(decimal.Add(out[i].LineTotal, lineTotal))
				continue
			}
			idx[key] = len(out)
		} else {
			// Штучные: qty в ключ НЕ входит — «x1» и «x3» одного блюда должны
			// схлопнуться в «x4», а не остаться двумя строками.
			key := name + "|" + it.Price.String() + "|" + note + "|" + unit
			if i, ok := idx[key]; ok {
				out[i].Qty = decimal.Normalize(decimal.Add(out[i].Qty, it.Qty))
				out[i].LineTotal = decimal.Normalize(decimal.Add(out[i].LineTotal, lineTotal))
				continue
			}
			idx[key] = len(out)
		}
		out = append(out, printGroup{
			Name:      name,
			Price:     it.Price,
			Note:      note,
			Qty:       it.Qty,
			Unit:      unit,
			UnitSize:  it.UnitSize,
			Count:     1,
			LineTotal: lineTotal,
		})
	}
	return out
}
