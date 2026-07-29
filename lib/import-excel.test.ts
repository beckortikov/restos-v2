import { describe, it, expect } from 'vitest'
import { parseDishRows } from './import-excel'

// Строка листа «Блюда» по колонкам A..Q (0..16); заполняем только значимые.
function row(over: Partial<Record<'cat' | 'name' | 'station' | 'price' | 'avail' | 'attr' | 'val', unknown>>): unknown[] {
  const r: unknown[] = new Array(17).fill(undefined)
  r[1] = over.cat ?? 'Пицца'
  r[2] = over.name
  r[3] = over.station ?? 'hot_kitchen'
  r[6] = over.price
  r[11] = over.avail ?? 'Да'
  r[15] = over.attr
  r[16] = over.val
  return r
}

const HEADER: unknown[] = ['№', 'Категория', 'Название']

describe('parseDishRows — вариации (колонки P/Q)', () => {
  it('схлопывает строки с одним названием в продукт с вариантами', () => {
    const { dishes, errors } = parseDishRows([
      HEADER,
      row({ name: 'Пицца Пепперони', price: 45, attr: 'Размер', val: '25' }),
      row({ name: 'Пицца Пепперони', price: 65, attr: 'Размер', val: 30 }),
      row({ name: 'Пицца Пепперони', price: 85, attr: 'Размер', val: '35', avail: 'Нет' }),
      row({ name: 'Фанта', cat: 'Напитки', station: 'bar', price: 7, attr: 'Объём', val: '0.5 л' }),
      row({ name: 'Фанта', cat: 'Напитки', station: 'bar', price: 12, attr: 'Объём', val: '1 л' }),
    ])
    expect(errors).toEqual([])
    expect(dishes).toHaveLength(2)
    const [pizza, fanta] = dishes
    expect(pizza.attrName).toBe('Размер')
    expect(pizza.price).toBe(0) // цены живут на вариантах
    expect(pizza.variants).toEqual([
      { label: '25', price: 45, isAvailable: true },
      { label: '30', price: 65, isAvailable: true },
      { label: '35', price: 85, isAvailable: false },
    ])
    expect(pizza.isAvailable).toBe(true) // хотя бы один вариант доступен
    expect(fanta.attrName).toBe('Объём')
    expect(fanta.variants).toHaveLength(2)
  })

  it('обычные строки без P/Q работают как раньше', () => {
    const { dishes, errors } = parseDishRows([
      HEADER,
      row({ name: 'Лагман', cat: 'Супы', price: 25 }),
    ])
    expect(errors).toEqual([])
    expect(dishes).toEqual([expect.objectContaining({ name: 'Лагман', price: 25, unit: 'piece' })])
    expect(dishes[0].attrName).toBeUndefined()
  })

  it('вариант без цены — ошибка с именем варианта', () => {
    const { errors } = parseDishRows([
      HEADER,
      row({ name: 'Пицца Цезарь', attr: 'Размер', val: '25' }),
    ])
    expect(errors.some(e => e.includes('Пицца Цезарь 25') && e.includes('цена'))).toBe(true)
  })

  it('повтор значения вариации — ошибка, строка пропускается', () => {
    const { dishes, errors } = parseDishRows([
      HEADER,
      row({ name: 'Мохито', price: 10, attr: 'Объём', val: '0.5 л' }),
      row({ name: 'Мохито', price: 12, attr: 'Объём', val: '0.5 л' }),
    ])
    expect(dishes[0].variants).toHaveLength(1)
    expect(errors.some(e => e.includes('повторяется'))).toBe(true)
  })

  it('разные атрибуты у одного продукта — предупреждение, используется первый', () => {
    const { dishes, errors } = parseDishRows([
      HEADER,
      row({ name: 'Кола', price: 5, attr: 'Объём', val: '0.5 л' }),
      row({ name: 'Кола', price: 8, attr: 'Размер', val: '1 л' }),
    ])
    expect(dishes[0].attrName).toBe('Объём')
    expect(dishes[0].variants).toHaveLength(2)
    expect(errors.some(e => e.includes('не совпадает'))).toBe(true)
  })

  it('заполнена только одна из колонок P/Q — ошибка', () => {
    const { errors } = parseDishRows([
      HEADER,
      row({ name: 'Чай', price: 3, attr: 'Размер' }),
    ])
    expect(errors.some(e => e.includes('обе колонки'))).toBe(true)
  })

  it('смешение обычной строки и вариаций с одним названием — ошибки', () => {
    const { dishes, errors } = parseDishRows([
      HEADER,
      row({ name: 'Пицца Кебаб', price: 50 }),
      row({ name: 'Пицца Кебаб', price: 60, attr: 'Размер', val: '30' }),
      row({ name: 'Шаурма', price: 20, attr: 'Размер', val: 'малая' }),
      row({ name: 'Шаурма', price: 25 }),
    ])
    // Кебаб: плоская строка + вариация → два блюда и предупреждение
    expect(errors.some(e => e.includes('Пицца Кебаб') && e.includes('два блюда'))).toBe(true)
    // Шаурма: плоская строка после вариаций пропускается
    expect(errors.some(e => e.includes('Шаурма') && e.includes('пропущена'))).toBe(true)
    expect(dishes.filter(d => d.name === 'Шаурма')).toHaveLength(1)
  })

  it('больше 10 значений — ошибка лимита', () => {
    const rows: unknown[][] = [HEADER]
    for (let i = 1; i <= 11; i++) rows.push(row({ name: 'Сок', price: i, attr: 'Объём', val: `${i} л` }))
    const { errors } = parseDishRows(rows)
    expect(errors.some(e => e.includes('максимум 10'))).toBe(true)
  })
})
