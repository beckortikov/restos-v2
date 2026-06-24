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

// groupPrintItems группирует ОДИНАКОВЫЕ ВЕСОВЫЕ порции (g/kg) в одну строку с
// Count. Штучные позиции (piece) не группируются — они и так уже одна строка с
// нужным qty. Порядок первого появления сохраняется. LineTotal суммируется из
// per-row значений (price×qty), т.е. логика цен НЕ меняется — просто 3 строки
// становятся одной с тем же итогом.
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
		lineTotal := decimal.Normalize(decimal.Mul(it.Price, it.Qty))
		isWeight := unit == "g" || unit == "kg"
		if isWeight {
			key := name + "|" + it.Price.String() + "|" + note + "|" + it.Qty.String() + "|" + unit
			if i, ok := idx[key]; ok {
				out[i].Count++
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
