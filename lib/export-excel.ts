'use client'
import * as XLSX from 'xlsx'
import { fetchMenuItems, fetchIngredients } from '@/lib/queries'
import { STATION_LABELS, type MenuItem, type Ingredient } from '@/lib/types'

export function exportToExcel(
  data: Record<string, unknown>[],
  columns: { key: string; header: string; format?: (v: unknown) => string | number }[],
  filename: string,
  sheetName = 'Отчёт'
) {
  // Build header row
  const headers = columns.map(c => c.header)
  // Build data rows
  const rows = data.map(row => columns.map(c => {
    const val = row[c.key]
    return c.format ? c.format(val) : val ?? ''
  }))
  // Create worksheet
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows])
  // Auto-width columns
  ws['!cols'] = columns.map(c => ({ wch: Math.max(c.header.length, 12) }))
  // Create workbook and save
  const wb = XLSX.utils.book_new()
  XLSX.utils.book_append_sheet(wb, ws, sheetName)
  XLSX.writeFile(wb, `${filename}.xlsx`)
}

// ─── Full menu export (matches the import template format) ──────────────────
//
// Produces a 3-sheet workbook compatible with parseDishesExcel /
// parseTechCardsExcel / parseIngredientsExcel from lib/import-excel.ts.
// Allows the manager to "snapshot" current menu, edit in Excel, then
// re-import it as updates.

const STATION_INV = Object.entries(STATION_LABELS).reduce<Record<string, string>>((acc, [k, v]) => {
  acc[k] = v
  return acc
}, {})

function unitLabel(u?: string): string {
  if (u === 'g') return 'грамм'
  if (u === 'kg') return 'кг'
  return 'шт'
}

export async function exportMenuTemplate(): Promise<void> {
  const [menuItems, ingredients] = await Promise.all([fetchMenuItems(), fetchIngredients()])
  const wb = XLSX.utils.book_new()
  const ingMap = new Map(ingredients.map(i => [i.id, i]))

  // ─ Sheet 1: Блюда ────────────────────────────────────────────────────────
  // Layout matches parseDishesExcel: A=#, B=Категория, C=Название,
  // D=Цех, E=Вес/порция, F=Себестоимость, G=Цена, K=Время гот., L=Доступно,
  // M=Ед, N=Размер, O=Шаг продажи. Columns H/I/J reserved for human notes.
  const dishHeaders = [
    '#', 'Категория', 'Название', 'Цех', 'Вес/порция', 'Себестоимость', 'Цена',
    'Маржа', 'Маржа %', 'Food cost %',
    'Время приг. (мин)', 'Доступно (Да/Нет)',
    'Ед. продажи', 'Размер ед.', 'Шаг продажи',
  ]
  const dishRows = menuItems.map((m, idx) => {
    const margin = (m.price || 0) - (m.cogs || 0)
    const marginPct = m.price > 0 ? Math.round((margin / m.price) * 1000) / 10 : 0
    const foodCostPct = m.price > 0 ? Math.round((m.cogs / m.price) * 1000) / 10 : 0
    return [
      idx + 1,
      m.category,
      m.name,
      STATION_INV[m.station] || m.station,
      0, // weight — нет в схеме MenuItem; оставляем для совместимости
      m.cogs,
      m.price,
      margin,
      marginPct,
      foodCostPct,
      m.cookTimeMin ?? '',
      m.isAvailable ? 'Да' : 'Нет',
      unitLabel(m.unit),
      m.unitSize ?? 1,
      m.saleStep ?? 0,
    ]
  })
  const dishSheet = XLSX.utils.aoa_to_sheet([dishHeaders, ...dishRows])
  dishSheet['!cols'] = [
    { wch: 5 }, { wch: 22 }, { wch: 32 }, { wch: 16 }, { wch: 11 }, { wch: 14 }, { wch: 10 },
    { wch: 10 }, { wch: 9 }, { wch: 12 },
    { wch: 18 }, { wch: 16 },
    { wch: 12 }, { wch: 11 }, { wch: 12 },
  ]
  // Freeze header row + first 3 columns for easy scrolling.
  dishSheet['!freeze'] = { xSplit: 3, ySplit: 1 }
  XLSX.utils.book_append_sheet(wb, dishSheet, 'Блюда')

  // ─ Sheet 2: Техкарты ─────────────────────────────────────────────────────
  // Layout matches parseTechCardsExcel: A=Блюдо (только в первой строке
  // блюда), B=Ингредиент, C=Масса (г), D=Ед, E=Цена за кг, F=Стоимость.
  const tcHeaders = ['Блюдо', 'Ингредиент', 'Масса (г)', 'Ед. изм.', 'Цена за ед.', 'Стоимость']
  const tcRows: (string | number)[][] = []
  for (const m of menuItems) {
    if (!m.techCard || m.techCard.length === 0) continue
    let first = true
    for (const line of m.techCard) {
      const ing = line.ingredientId ? ingMap.get(line.ingredientId) : null
      const ingName = line.name || ing?.name || ''
      const massG = Number(line.qty) || 0
      const unit = ing?.unit || line.unit || 'g'
      const pricePerUnit = ing?.pricePerUnit || 0
      const cost = (massG * pricePerUnit) / (unit === 'g' || unit === 'мл' ? 1000 : 1)
      tcRows.push([
        first ? m.name : '',
        ingName,
        massG,
        unit,
        pricePerUnit,
        Math.round(cost * 100) / 100,
      ])
      first = false
    }
    // Spacer row for readability.
    tcRows.push(['', '', '', '', '', ''])
  }
  const tcSheet = XLSX.utils.aoa_to_sheet([tcHeaders, ...tcRows])
  tcSheet['!cols'] = [
    { wch: 32 }, { wch: 28 }, { wch: 12 }, { wch: 10 }, { wch: 14 }, { wch: 12 },
  ]
  tcSheet['!freeze'] = { xSplit: 0, ySplit: 1 }
  XLSX.utils.book_append_sheet(wb, tcSheet, 'Техкарты')

  // ─ Sheet 3: Ингредиенты ──────────────────────────────────────────────────
  const ingHeaders = ['#', 'Категория', 'Название', 'Ед. изм.', 'Остаток', 'Мин. остаток', 'Цена за ед.', 'Угар %', 'Тип']
  const ingRows = ingredients.map((i: Ingredient, idx) => [
    idx + 1,
    i.category,
    i.name,
    i.unit,
    i.qty,
    i.minQty,
    i.pricePerUnit,
    i.wastePercent ?? 0,
    i.isFood ? 'Продукт' : 'Хозтовары',
  ])
  const ingSheet = XLSX.utils.aoa_to_sheet([ingHeaders, ...ingRows])
  ingSheet['!cols'] = [
    { wch: 5 }, { wch: 18 }, { wch: 28 }, { wch: 8 }, { wch: 10 }, { wch: 12 }, { wch: 14 }, { wch: 8 }, { wch: 12 },
  ]
  ingSheet['!freeze'] = { xSplit: 3, ySplit: 1 }
  XLSX.utils.book_append_sheet(wb, ingSheet, 'Ингредиенты')

  // ─ Sheet 4: Подсказка (как редактировать) ────────────────────────────────
  const helpRows = [
    ['Шаблон меню — RestOS'],
    [''],
    ['Этот файл — снимок текущего меню. Можно отредактировать и заново загрузить через "Импорт данных".'],
    [''],
    ['Листы:'],
    ['• Блюда — категории, цены, себестоимость, цех, ед. продажи (шт/г/кг).'],
    ['• Техкарты — состав каждого блюда: ингредиент + грамм. Имя блюда — только в первой строке.'],
    ['• Ингредиенты — справочник продуктов и хозтоваров с остатками.'],
    [''],
    ['Цеха: Горячий цех, Холодный цех, Шашлычный, Бар, Витрина.'],
    ['Поле "Доступно" — Да/Нет (Нет = блюдо в стоп-листе).'],
    ['"Ед. продажи": шт (по штукам), грамм (продаётся весом, цена за "Размер ед." грамм), кг (за килограмм).'],
  ]
  const helpSheet = XLSX.utils.aoa_to_sheet(helpRows)
  helpSheet['!cols'] = [{ wch: 110 }]
  XLSX.utils.book_append_sheet(wb, helpSheet, 'Как редактировать')

  const today = new Date().toISOString().slice(0, 10)
  XLSX.writeFile(wb, `restos-menu-${today}.xlsx`)
}
