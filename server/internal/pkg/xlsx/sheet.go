// Package xlsx — тонкая обёртка над github.com/xuri/excelize/v2.
//
// Принцип: каждый отчёт собирается через Sheet — добавляешь Header строки,
// затем построчно AddRow с типизированными значениями. Sheet.WriteTo пишет
// в io.Writer (HTTP-handler пишет напрямую в response).
//
// Стилизация минималистичная: жирный header с серым фоном, автоширина колонок
// до 30 символов. Не претендуем на красивые финансовые отчёты — Phase 9.
package xlsx

import (
	"fmt"
	"io"
	"time"

	"github.com/xuri/excelize/v2"

	"github.com/restos/restos-v4/server/internal/pkg/decimal"
)

// Sheet — wrapper над одним excelize-листом.
type Sheet struct {
	f          *excelize.File
	sheetName  string
	headerCols []string
	row        int // 1-based, header = 1
}

// New создаёт книгу с одним листом. sheetName ≤ 31 символа (Excel ограничение).
func New(sheetName string) *Sheet {
	if len(sheetName) > 31 {
		sheetName = sheetName[:31]
	}
	f := excelize.NewFile()
	// Дефолтный лист переименовываем.
	idx, _ := f.GetSheetIndex("Sheet1")
	if idx >= 0 {
		_ = f.SetSheetName("Sheet1", sheetName)
	} else {
		_, _ = f.NewSheet(sheetName)
	}
	return &Sheet{f: f, sheetName: sheetName}
}

// Header пишет первую строку с названиями колонок и применяет bold-стиль.
func (s *Sheet) Header(cols ...string) {
	s.headerCols = cols
	s.row = 1
	for i, c := range cols {
		cell, _ := excelize.CoordinatesToCellName(i+1, 1)
		_ = s.f.SetCellValue(s.sheetName, cell, c)
	}
	style, _ := s.f.NewStyle(&excelize.Style{
		Font: &excelize.Font{Bold: true},
		Fill: excelize.Fill{Type: "pattern", Pattern: 1, Color: []string{"E0E0E0"}},
	})
	first, _ := excelize.CoordinatesToCellName(1, 1)
	last, _ := excelize.CoordinatesToCellName(len(cols), 1)
	_ = s.f.SetCellStyle(s.sheetName, first, last, style)
	// Простая автоширина: 18 — компромисс между «помещается» и «не разбухнуть».
	_ = s.f.SetColWidth(s.sheetName, "A", colLetter(len(cols)), 18)
	s.row = 2
}

// AddRow добавляет строку. Поддерживаемые типы значений: string, int, float64,
// decimal.Decimal, time.Time, bool, nil. Остальное — Sprintf("%v").
func (s *Sheet) AddRow(vals ...any) {
	for i, v := range vals {
		cell, _ := excelize.CoordinatesToCellName(i+1, s.row)
		switch x := v.(type) {
		case nil:
			// пусто
		case string:
			_ = s.f.SetCellValue(s.sheetName, cell, x)
		case int:
			_ = s.f.SetCellValue(s.sheetName, cell, x)
		case int64:
			_ = s.f.SetCellValue(s.sheetName, cell, x)
		case float64:
			_ = s.f.SetCellValue(s.sheetName, cell, x)
		case bool:
			_ = s.f.SetCellValue(s.sheetName, cell, x)
		case time.Time:
			_ = s.f.SetCellValue(s.sheetName, cell, x.Format("2006-01-02 15:04:05"))
		case *time.Time:
			if x != nil {
				_ = s.f.SetCellValue(s.sheetName, cell, x.Format("2006-01-02 15:04:05"))
			}
		case decimal.Decimal:
			// В Excel — как число float (с округлением до 4 знаков).
			f, _ := x.RoundBank(4).Float64()
			_ = s.f.SetCellValue(s.sheetName, cell, f)
		case *decimal.Decimal:
			if x != nil {
				f, _ := x.RoundBank(4).Float64()
				_ = s.f.SetCellValue(s.sheetName, cell, f)
			}
		case *string:
			if x != nil {
				_ = s.f.SetCellValue(s.sheetName, cell, *x)
			}
		case *int:
			if x != nil {
				_ = s.f.SetCellValue(s.sheetName, cell, *x)
			}
		default:
			_ = s.f.SetCellValue(s.sheetName, cell, fmt.Sprintf("%v", v))
		}
	}
	s.row++
}

// WriteTo сериализует книгу в writer (HTTP response).
func (s *Sheet) WriteTo(w io.Writer) (int64, error) {
	return s.f.WriteTo(w)
}

// Close освобождает ресурсы excelize.
func (s *Sheet) Close() error { return s.f.Close() }

// File возвращает underlying *excelize.File для редких случаев (multi-sheet
// отчёты с кастомным форматированием).
func (s *Sheet) File() *excelize.File { return s.f }

// AddSheet добавляет ещё один лист и возвращает его. Полезно для multi-tab
// отчётов (Z-отчёт: header + операции + заказы).
func (s *Sheet) AddSheet(name string) *Sheet {
	if len(name) > 31 {
		name = name[:31]
	}
	_, _ = s.f.NewSheet(name)
	return &Sheet{f: s.f, sheetName: name}
}

// colLetter — 1→A, 27→AA. Простейшая конверсия для setColWidth.
func colLetter(n int) string {
	if n <= 0 {
		return "A"
	}
	res := ""
	for n > 0 {
		n--
		res = string(rune('A'+n%26)) + res
		n /= 26
	}
	return res
}
