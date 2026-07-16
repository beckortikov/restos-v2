import { describe, it, expect } from 'vitest'
import { mergeCategories } from './use-order-data'
import type { MenuCategory } from '@/lib/queries'
import type { MenuItem } from '@/lib/types'

const cat = (name: string, sortOrder: number): MenuCategory => ({ id: name, name, sortOrder })
const dish = (category: string): MenuItem => ({ category } as MenuItem)

describe('mergeCategories', () => {
  it('показывает ПУСТЫЕ категории таблицы (без блюд) — суть фикса', () => {
    const cats = [cat('Десерты', 2), cat('Напитки', 1)]
    // Ни одного блюда в этих категориях.
    expect(mergeCategories(cats, [])).toEqual(['Напитки', 'Десерты'])
  })

  it('порядок — по sortOrder таблицы, не по алфавиту', () => {
    const cats = [cat('Салаты', 3), cat('Супы', 1), cat('Горячее', 2)]
    expect(mergeCategories(cats, [dish('Салаты'), dish('Супы')])).toEqual(['Супы', 'Горячее', 'Салаты'])
  })

  it('категории из блюд, отсутствующие в таблице, добавляются в конец (ничего не теряем)', () => {
    const cats = [cat('Напитки', 1)]
    const items = [dish('Импорт-без-записи'), dish('Напитки')]
    expect(mergeCategories(cats, items)).toEqual(['Напитки', 'Импорт-без-записи'])
  })

  it('дедуп без учёта регистра — запись таблицы побеждает', () => {
    const cats = [cat('Напитки', 1)]
    const items = [dish('напитки')]
    expect(mergeCategories(cats, items)).toEqual(['Напитки'])
  })

  it('пустая таблица → поведение как раньше (только из блюд, по алфавиту)', () => {
    expect(mergeCategories([], [dish('Супы'), dish('Салаты')])).toEqual(['Салаты', 'Супы'])
  })

  it('пустые/пробельные имена игнорируются', () => {
    const cats = [cat('  ', 1), cat('Напитки', 2)]
    expect(mergeCategories(cats, [])).toEqual(['Напитки'])
  })
})
