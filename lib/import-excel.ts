'use client'

import * as XLSX from 'xlsx'

// ─── Floor Map ───────────────────────────────────────────────────────────────

export interface ParsedZone { name: string }
export interface ParsedTable { name: string; number: number; capacity: number; zone: string }
export interface ParsedFloorMap { zones: ParsedZone[]; tables: ParsedTable[]; errors: string[] }

// ─── Menu (Dishes) ───────────────────────────────────────────────────────────

export interface ParsedDish {
  name: string
  category: string
  station: string
  weight: number
  cogs: number
  price: number
  cookTimeMin: number
  isAvailable: boolean
  // Weight-based sales (optional — default to per-piece)
  unit: 'piece' | 'g' | 'kg'
  unitSize: number   // e.g. 100 for "price per 100g"
  saleStep: number   // granularity in grams (0 = any qty)
}

export interface ParsedDishList { dishes: ParsedDish[]; errors: string[] }

// ─── Tech Cards ──────────────────────────────────────────────────────────────

export interface ParsedTechCardLine {
  dishName: string
  ingredientName: string
  massG: number
  unit: string
  pricePerKg: number
  cost: number
}

export interface ParsedTechCards { lines: ParsedTechCardLine[]; dishCount: number; errors: string[] }

// ─── Ingredients ─────────────────────────────────────────────────────────────

export interface ParsedIngredient {
  name: string
  unit: string
  pricePerUnit: number
  wastePercent: number
  minQty: number
  category: string
}

export interface ParsedIngredientList { ingredients: ParsedIngredient[]; errors: string[] }

export function parseFloorMapExcel(file: File): Promise<ParsedFloorMap> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        const wb = XLSX.read(data, { type: 'array' })
        const errors: string[] = []

        // Parse Zones sheet
        const zonesSheet = wb.Sheets['Зоны'] || wb.Sheets[wb.SheetNames[0]]
        const zonesData = XLSX.utils.sheet_to_json<unknown[]>(zonesSheet, { header: 1 })
        const zones: ParsedZone[] = []

        for (let i = 1; i < zonesData.length; i++) {
          const row = zonesData[i] as unknown[]
          if (!row || !row[1]) continue
          const name = String(row[1]).trim()
          if (name && name.length > 0) {
            zones.push({ name })
          }
        }

        if (zones.length === 0) {
          errors.push('Лист "Зоны" пуст — добавьте хотя бы одну зону')
        }

        // Parse Tables sheet
        const tablesSheet = wb.Sheets['Столы'] || wb.Sheets[wb.SheetNames[1]]
        const tablesData = XLSX.utils.sheet_to_json<unknown[]>(tablesSheet, { header: 1 })
        const tables: ParsedTable[] = []
        const zoneNames = new Set(zones.map(z => z.name.toLowerCase()))

        for (let i = 1; i < tablesData.length; i++) {
          const row = tablesData[i] as unknown[]
          if (!row || !row[1]) continue

          const name = String(row[1]).trim()

          // Skip summary/formula rows
          if (!name) continue
          if (name.toLowerCase().startsWith('итого')) continue
          if (name.toLowerCase().includes('итого')) continue
          if (name.toLowerCase().includes('всего')) continue

          const num = Number(row[2]) || i
          const capacity = Number(row[3]) || 4
          const zone = String(row[4] || '').trim()

          // Skip rows without a valid zone (likely summary rows)
          if (!zone) continue

          if (zone && !zoneNames.has(zone.toLowerCase())) {
            errors.push(`Стол "${name}": зона "${zone}" не найдена в списке зон`)
          }

          tables.push({ name, number: num, capacity, zone })
        }

        if (tables.length === 0) {
          errors.push('Лист "Столы" пуст — добавьте хотя бы один стол')
        }

        // Check duplicates
        const names = tables.map(t => t.name.toLowerCase())
        const dupes = names.filter((n, i) => names.indexOf(n) !== i)
        if (dupes.length > 0) {
          errors.push(`Дублирующиеся названия столов: ${[...new Set(dupes)].join(', ')}`)
        }

        resolve({ zones, tables, errors })
      } catch (err) {
        reject(new Error('Ошибка чтения файла: ' + (err instanceof Error ? err.message : String(err))))
      }
    }
    reader.onerror = () => reject(new Error('Ошибка чтения файла'))
    reader.readAsArrayBuffer(file)
  })
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readFile(file: File): Promise<XLSX.WorkBook> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = (e) => {
      try {
        const data = new Uint8Array(e.target?.result as ArrayBuffer)
        resolve(XLSX.read(data, { type: 'array' }))
      } catch (err) { reject(err) }
    }
    reader.onerror = () => reject(new Error('Ошибка чтения'))
    reader.readAsArrayBuffer(file)
  })
}

// ─── Parse Dishes (Блюда sheet) ──────────────────────────────────────────────
// Columns (0-indexed):
//   A(0) № | B(1) Категория | C(2) Название | D(3) Станция
//   E(4) Вес порции (г) ↻   — auto via SUMIF from Техкарты
//   F(5) Себест. порции     — auto via SUMIF
//   G(6) Цена продажи
//   H(7) Food Cost %        — auto
//   I(8) Наценка %          — auto
//   J(9) Кол-во ингр. ↻     — auto
//   K(10) Время (мин)
//   L(11) Доступно
//   M(12) Ед. продажи (piece | g | kg) — optional, default 'piece'
//   N(13) Размер порции     — for g: portion weight in grams (e.g. 100),
//                             for piece/kg: 1
//   O(14) Шаг (г)           — weight granularity (0 = any),
//                             used for g/kg items sold by weight

// Map Russian/English unit aliases to canonical values
function normalizeUnit(raw: string): 'piece' | 'g' | 'kg' {
  const s = raw.trim().toLowerCase()
  if (!s) return 'piece'
  if (/(kg|кг|килограмм)/.test(s)) return 'kg'
  if (/^(g|гр|грамм|по\s*100|100\s*г)/.test(s)) return 'g'
  if (/^(шт|штук|piece|pc)/.test(s)) return 'piece'
  return 'piece'
}

export async function parseDishesExcel(file: File): Promise<ParsedDishList> {
  const wb = await readFile(file)
  const ws = wb.Sheets['Блюда'] || wb.Sheets[wb.SheetNames[0]]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })
  const errors: string[] = []
  const dishes: ParsedDish[] = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[]
    if (!row || !row[2]) continue // column C = name

    const name = String(row[2]).trim()
    if (!name) continue

    const category = String(row[1] || '').trim()
    const station = String(row[3] || 'hot_kitchen').trim()
    const weight = Number(row[4]) || 0
    const cogs = Number(row[5]) || 0
    const price = Number(row[6]) || 0
    const cookTimeMin = Number(row[10]) || 0
    const isAvailable = String(row[11] || 'Да').trim().toLowerCase() !== 'нет'

    // Weight-based sales columns (M/N/O) — backward compat: missing = per-piece
    const unit = normalizeUnit(String(row[12] || 'piece'))
    const rawSize = Number(row[13])
    const unitSize = unit === 'g'
      ? (rawSize > 0 ? rawSize : 100)  // default 100g for gram-sold items
      : 1                               // piece/kg always unit_size=1
    const saleStep = Number(row[14]) || 0

    if (!category) errors.push(`Строка ${i + 1}: блюдо "${name}" без категории`)
    if (price <= 0) errors.push(`Строка ${i + 1}: блюдо "${name}" без цены продажи`)

    dishes.push({ name, category, station, weight, cogs, price, cookTimeMin, isAvailable, unit, unitSize, saleStep })
  }

  return { dishes, errors }
}

// ─── Parse Tech Cards (Техкарты sheet) ───────────────────────────────────────

export async function parseTechCardsExcel(file: File): Promise<ParsedTechCards> {
  const wb = await readFile(file)
  const ws = wb.Sheets['Техкарты'] || wb.Sheets[wb.SheetNames[1]]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })
  const errors: string[] = []
  const lines: ParsedTechCardLine[] = []
  let currentDish = ''
  const dishNames = new Set<string>()

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[]
    if (!row) continue

    // Column A = dish name (only on first line of each dish)
    if (row[0] && String(row[0]).trim()) {
      currentDish = String(row[0]).trim()
      dishNames.add(currentDish)
    }

    const ingredientName = String(row[2] || '').trim()
    if (!ingredientName || ingredientName === 'ИТОГО') continue
    if (!currentDish) continue

    const massG = Number(row[3]) || 0
    const unit = String(row[4] || 'г').trim()
    const pricePerKg = Number(row[5]) || 0
    const cost = Number(row[6]) || 0

    if (massG <= 0) continue

    lines.push({ dishName: currentDish, ingredientName, massG, unit, pricePerKg, cost })
  }

  return { lines, dishCount: dishNames.size, errors }
}

// ─── Parse Ingredients (Ингредиенты sheet) ───────────────────────────────────

export async function parseIngredientsExcel(file: File): Promise<ParsedIngredientList> {
  const wb = await readFile(file)
  const ws = wb.Sheets['Ингредиенты'] || wb.Sheets[wb.SheetNames[2]]
  const rows = XLSX.utils.sheet_to_json<unknown[]>(ws, { header: 1 })
  const errors: string[] = []
  const ingredients: ParsedIngredient[] = []

  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] as unknown[]
    if (!row || !row[1]) continue

    const name = String(row[1]).trim()
    if (!name || name.length < 2) continue

    const unit = String(row[2] || 'кг').trim()
    const pricePerUnit = Number(row[3]) || 0
    const wastePercent = Number(row[4]) || 0
    const minQty = Number(row[5]) || 0
    const category = String(row[6] || 'Прочее').trim()

    if (pricePerUnit <= 0) errors.push(`"${name}": цена не указана`)

    ingredients.push({ name, unit, pricePerUnit, wastePercent, minQty, category })
  }

  return { ingredients, errors }
}
