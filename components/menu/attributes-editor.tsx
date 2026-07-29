'use client'

import { useState, useEffect } from 'react'
import { Plus, Trash2, X, Layers, Ruler } from 'lucide-react'
import { toast } from 'sonner'
import type { MenuItem, MenuAttribute, SizeScale } from '@/lib/types'
import { fetchMenuAttributes, syncMenuAttributes, toggleMenuAvailability, fetchSizeScales } from '@/lib/queries'
import { DecimalInput } from '@/components/ui/decimal-input'
import { humanizeError } from '@/lib/errors'

// Локальная форма атрибута: массивы = порядок; id пустой у новых.
// Значение атрибута — чистый лейбл. Цена и закупка задаются на КОМБИНАЦИИ
// (см. ComboPricesEditor): никаких «надбавок» и базовой цены.
export interface AttrValueForm {
  id?: string
  label: string
  // Если значение зеркалит шкалу размеров — id соответствующего SizeScaleValue
  // (для подсказки «эта заготовка — этого размера» до сохранения на бэке,
  // когда ни у значения, ни у варианта ещё нет собственного id).
  sizeScaleValueId?: string
}
export interface AttrForm {
  id?: string
  name: string
  values: AttrValueForm[]
  // Если задан — values зеркалят значения этой шкалы размеров (только для
  // отображения/расчёта комбинаций на фронте); при сохранении сервер сам
  // подставляет актуальные значения шкалы, values в payload не идёт.
  sizeScaleId?: string
}

/** Значения атрибута из выбранной шкалы (лейбл = title, иначе code). */
function valuesFromScale(scale: SizeScale): AttrValueForm[] {
  return scale.values.map(v => ({ label: v.title || v.code, sizeScaleValueId: v.id }))
}

// Цены комбинаций: ключ — лейблы в порядке атрибутов через \x1f.
export type ComboPrices = Record<string, { price: number; purchase: number }>

export const MAX_ATTRS = 3
const MAX_VALUES = 10
export const MAX_COMBOS = 60

// Идентичность значения — стабильна при переименовании лейбла. Приоритет:
// id значения (backend UUID, при правке лейбла НЕ меняется) → id значения шкалы
// размеров → как фолбэк лейбл (для новых значений без id, в форме создания).
function valueIdentity(v: { id?: string; sizeScaleValueId?: string; label: string }): string {
  return v.id ?? v.sizeScaleValueId ?? 'lbl:' + v.label.trim()
}

// Ключ комбинации — отсортированный набор идентичностей её значений. Ключуем по
// id значения, а не по лейблу: переименование значения больше НЕ обнуляет его
// цену/закупку в форме (баг «правка варианта удаляет цены»). Сортировка делает
// ключ независимым и от порядка атрибутов.
export function comboKeyOf(values: { id?: string; sizeScaleValueId?: string; label: string }[]): string {
  return values.map(valueIdentity).sort().join('\x1f')
}

/**
 * Ключ комбинации по НАБОРУ лейблов (сортированный, не по порядку атрибутов).
 * Бэк возвращает variantValueIds отсортированными (не в порядке атрибутов) —
 * поэтому сопоставлять локальную комбинацию созданному варианту после
 * PUT /attributes нужно по множеству лейблов, а не по comboKeyOf-порядку.
 */
export function comboLabelSetKey(labels: string[]): string {
  return [...labels].map(l => l.trim()).sort().join('\x1f')
}

/** Комбинации (декартово произведение заполненных значений) в порядке атрибутов. */
export function combosOf(attrs: AttrForm[]): { key: string; labels: string[]; title: string; sizeScaleValueIds: string[] }[] {
  if (attrs.length === 0) return []
  let acc: AttrValueForm[][] = [[]]
  for (const a of attrs) {
    const values = a.values.filter(v => v.label.trim())
    if (values.length === 0) return []
    const next: AttrValueForm[][] = []
    for (const c of acc) for (const v of values) next.push([...c, v])
    acc = next
  }
  return acc.map(combo => {
    const labels = combo.map(v => v.label.trim())
    const sizeScaleValueIds = combo.map(v => v.sizeScaleValueId).filter((x): x is string => !!x)
    return { key: comboKeyOf(combo), labels, title: labels.join(' · '), sizeScaleValueIds }
  })
}

export function combosCount(attrs: AttrForm[]): number {
  return combosOf(attrs).length
}

/** Все ли поля формы атрибутов заполнены (имена, значения). */
export function attrsComplete(attrs: AttrForm[]): boolean {
  return attrs.every(a => a.name.trim() && a.values.length > 0 && a.values.every(v => v.label.trim()))
}

/** Пригодно ли к сохранению: атрибуты заполнены, у каждой комбинации цена > 0
 *  (и закупка > 0 для покупного товара). */
export function attrsValid(attrs: AttrForm[], prices: ComboPrices, purchased?: boolean): boolean {
  if (attrs.length === 0 || !attrsComplete(attrs)) return false
  const combos = combosOf(attrs)
  if (combos.length === 0 || combos.length > MAX_COMBOS) return false
  return combos.every(c => {
    const p = prices[c.key]
    return p && p.price > 0 && (!purchased || p.purchase > 0)
  })
}

/** Payload для syncMenuAttributes из локальной формы. */
export function buildCombosPayload(attrs: AttrForm[], prices: ComboPrices) {
  return combosOf(attrs).map(c => ({
    labels: c.labels,
    price: prices[c.key]?.price ?? 0,
    purchasePrice: prices[c.key]?.purchase ?? 0,
  }))
}

/**
 * Контролируемая форма атрибутов (лейблы) — без загрузки/сохранения.
 * Используется на странице создания и внутри AttributesEditor.
 */
export function AttributesForm({ attrs, onChange }: {
  attrs: AttrForm[]
  onChange: (next: AttrForm[]) => void
}) {
  const [scales, setScales] = useState<SizeScale[]>([])
  useEffect(() => { fetchSizeScales().then(setScales).catch(() => {}) }, [])

  return (
    <div className="space-y-3">
      {attrs.map((attr, ai) => {
        const scaleLinked = !!attr.sizeScaleId
        const selectedScale = scales.find(s => s.id === attr.sizeScaleId)
        return (
        <div key={attr.id ?? `new-${ai}`} className="p-3 bg-muted/20 border border-border/50 rounded-xl space-y-2.5">
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={attr.name}
              onChange={e => onChange(attrs.map((a, i) => i === ai ? { ...a, name: e.target.value } : a))}
              placeholder={ai === 0 ? 'Атрибут, например «Размер»' : 'Атрибут, например «Вкус»'}
              className="flex-1 px-3 py-1.5 text-sm font-semibold bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            <button
              type="button"
              onClick={() => onChange(attrs.filter((_, i) => i !== ai))}
              className="p-1.5 text-destructive hover:bg-destructive/10 rounded-lg transition-colors"
              title="Удалить атрибут (его варианты уйдут в архив)"
            >
              <Trash2 className="size-4" />
            </button>
          </div>

          {scales.length > 0 && (
            <div className="flex items-center gap-1.5 text-xs">
              <Ruler className="size-3.5 text-muted-foreground shrink-0" />
              <select
                value={attr.sizeScaleId ?? ''}
                onChange={e => {
                  const scaleId = e.target.value
                  if (!scaleId) {
                    onChange(attrs.map((a, i) => i === ai ? { ...a, sizeScaleId: undefined } : a))
                    return
                  }
                  const scale = scales.find(s => s.id === scaleId)
                  onChange(attrs.map((a, i) => i === ai
                    ? { ...a, sizeScaleId: scaleId, values: scale ? valuesFromScale(scale) : a.values }
                    : a))
                }}
                className="flex-1 px-2 py-1 bg-background border border-border rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-primary/30"
              >
                <option value="">Свободный ввод значений</option>
                {scales.map(s => (
                  <option key={s.id} value={s.id}>Из шкалы: {s.name}</option>
                ))}
              </select>
            </div>
          )}

          {scaleLinked ? (
            <div className="flex flex-wrap gap-1.5">
              {attr.values.map((v, vi) => (
                <span key={vi} className="px-2 py-1 bg-background border border-border/50 rounded-lg text-xs text-foreground">{v.label}</span>
              ))}
              {attr.values.length === 0 && (
                <span className="text-xs text-amber-600">У шкалы «{selectedScale?.name}» нет значений</span>
              )}
              <span className="text-[10px] text-muted-foreground w-full">
                Значения редактируются в разделе «Шкалы размеров».
              </span>
            </div>
          ) : (
          <div className="space-y-1.5">
            {attr.values.map((val, vi) => (
              <div key={val.id ?? `new-${vi}`} className="grid grid-cols-[1fr_2rem] gap-2 items-center">
                <input
                  type="text"
                  value={val.label}
                  onChange={e => onChange(attrs.map((a, i) => i === ai
                    ? { ...a, values: a.values.map((v, j) => j === vi ? { ...v, label: e.target.value } : v) }
                    : a))}
                  placeholder={ai === 0 ? 'Значение, например «1 л»' : 'Значение, например «Виноград»'}
                  className="px-3 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
                />
                <button
                  type="button"
                  onClick={() => onChange(attrs.map((a, i) => i === ai
                    ? { ...a, values: a.values.filter((_, j) => j !== vi) }
                    : a))}
                  disabled={attr.values.length <= 1}
                  className="p-1 text-muted-foreground hover:text-destructive hover:bg-destructive/10 rounded transition-colors disabled:opacity-30"
                >
                  <X className="size-3.5" />
                </button>
              </div>
            ))}
            {attr.values.length < MAX_VALUES && (
              <button
                type="button"
                onClick={() => onChange(attrs.map((a, i) => i === ai
                  ? { ...a, values: [...a.values, { label: '' }] }
                  : a))}
                className="flex items-center gap-1 text-xs font-semibold text-primary hover:text-primary/80 py-1 px-2 rounded-lg hover:bg-primary/5 transition-colors"
              >
                <Plus className="size-3.5" /> Значение
              </button>
            )}
          </div>
          )}
        </div>
        )
      })}

      {attrs.length < MAX_ATTRS && (
        <button
          type="button"
          onClick={() => onChange([...attrs, { name: '', values: [{ label: '' }] }])}
          className="flex items-center gap-1.5 text-sm font-semibold text-primary hover:text-primary/80 transition-colors py-1.5 px-3 rounded-lg hover:bg-primary/5 border border-dashed border-primary/20 w-full justify-center"
        >
          <Plus className="size-4" /> Добавить атрибут
        </button>
      )}

      {combosCount(attrs) > MAX_COMBOS && (
        <p className="text-xs font-medium text-amber-600">Слишком много комбинаций ({combosCount(attrs)}), максимум {MAX_COMBOS}.</p>
      )}
    </div>
  )
}

/**
 * Цены комбинаций: строка на каждую комбинацию значений («1 л · Виноград»),
 * цена продажи + закупка (для покупных). Появляется как только заполнены
 * лейблы значений.
 */
export function ComboPricesEditor({ attrs, prices, onChange, showPurchase }: {
  attrs: AttrForm[]
  prices: ComboPrices
  onChange: (next: ComboPrices) => void
  showPurchase?: boolean
}) {
  const combos = combosOf(attrs)
  if (combos.length === 0) return null
  return (
    <div className="space-y-1.5 pt-3 border-t border-border">
      <div className={`grid ${showPurchase ? 'grid-cols-[1fr_6rem_6rem]' : 'grid-cols-[1fr_7rem]'} gap-2 px-1`}>
        <span className="text-[10px] font-semibold text-muted-foreground">Вариант ({combos.length})</span>
        <span className="text-[10px] font-semibold text-muted-foreground">Цена продажи</span>
        {showPurchase && <span className="text-[10px] font-semibold text-muted-foreground">Закупочная цена</span>}
      </div>
      {combos.map(c => {
        const p = prices[c.key] ?? { price: 0, purchase: 0 }
        return (
          <div key={c.key} className={`grid ${showPurchase ? 'grid-cols-[1fr_6rem_6rem]' : 'grid-cols-[1fr_7rem]'} gap-2 items-center`}>
            <span className="px-1 text-sm font-medium text-foreground truncate">{c.title}</span>
            <DecimalInput
              value={p.price}
              min={0}
              onChange={v => onChange({ ...prices, [c.key]: { ...p, price: v } })}
              className="px-3 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            />
            {showPurchase && (
              <DecimalInput
                value={p.purchase}
                min={0}
                onChange={v => onChange({ ...prices, [c.key]: { ...p, purchase: v } })}
                className="px-3 py-1.5 text-sm bg-background border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
              />
            )}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Атрибуты продукта + цены комбинаций — режим редактирования существующего
 * продукта (грузит и сохраняет на бэк). Варианты — реальные menu_items с
 * parent_id; генерирует их бэк на PUT /menu/items/{id}/attributes.
 */
export function AttributesEditor({ productId, isPurchased, onHasAttributesChange, onDirtyChange, onVariantsChange, onEnsurePurchased }: {
  productId: string
  isPurchased?: boolean
  /** Родительская форма скрывает поля цены/закупки, когда атрибуты есть. */
  onHasAttributesChange?: (has: boolean) => void
  /** Есть несохранённые правки атрибутов/цен — родитель не должен молча
   *  уходить со страницы («Сохранить изменения» их не затрагивает). */
  onDirtyChange?: (dirty: boolean) => void
  /** Живые варианты + атрибуты после загрузки/сохранения — для родителя,
   *  которому нужен актуальный список SKU (например «Техкарты по вариантам»). */
  onVariantsChange?: (attributes: MenuAttribute[], variants: MenuItem[]) => void
  /** Досохранить конвертацию в «Покупной» ПЕРЕД синком вариантов. Нужен на
   *  странице правки: закупка по вариациям применяется, только когда товар уже
   *  покупной на бэке. Без этого при конвертации в один заход
   *  («Сохранить варианты» до «Сохранить изменения») введённые закупки молча
   *  терялись. No-op, если товар уже покупной. */
  onEnsurePurchased?: () => Promise<void>
}) {
  const [attrs, setAttrs] = useState<AttrForm[]>([])
  const [prices, setPrices] = useState<ComboPrices>({})
  const [variants, setVariants] = useState<MenuItem[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [dirty, setDirtyState] = useState(false)
  const setDirty = (v: boolean) => { setDirtyState(v); onDirtyChange?.(v) }

  useEffect(() => {
    fetchMenuAttributes(productId)
      .then(state => {
        const loadedAttrs: AttrForm[] = state.attributes.map(a => ({
          id: a.id,
          name: a.name,
          sizeScaleId: a.sizeScaleId ?? undefined,
          values: a.values.map(v => ({ id: v.id, label: v.label })),
        }))
        // Цены комбинаций восстанавливаем из вариантов по НАБОРУ id значений
        // (value_ids) — тем же ключом, что и comboKeyOf(combo) в форме (набор
        // идентичностей, отсортирован). Ключ по id, а не по лейблам: при
        // переименовании значения его цена/закупка не «осиротеет».
        // price/cogs приходят строками (mapMenuItem) — приводим к числу.
        const loadedPrices: ComboPrices = {}
        for (const v of state.variants) {
          const ids = (v.variantValueIds ?? []).map(String)
          if (ids.length === 0) continue
          loadedPrices[ids.slice().sort().join('\x1f')] = {
            price: Number(v.price) || 0,
            purchase: Number(v.cogs ?? 0) || 0,
          }
        }
        setAttrs(loadedAttrs)
        setPrices(loadedPrices)
        setVariants(state.variants)
        onHasAttributesChange?.(state.attributes.length > 0)
        onVariantsChange?.(state.attributes, state.variants)
        setLoading(false)
      })
      .catch(() => setLoading(false))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [productId])

  const canSave = dirty && !saving && (attrs.length === 0 || attrsValid(attrs, prices, isPurchased))
  // Почему «Сохранить варианты» недоступно — раньше кнопка просто серела без
  // объяснения, и пользователь не понимал, что цена/закупка не введены у
  // какой-то комбинации (легко пропустить одну строку среди 8+ вариантов).
  const saveDisabledReason = saving ? ''
    : !dirty ? ''
    : !attrsComplete(attrs) ? 'Заполните названия атрибутов и значений'
    : combosCount(attrs) > MAX_COMBOS ? `Слишком много комбинаций (максимум ${MAX_COMBOS})`
    : combosOf(attrs).some(c => !((prices[c.key]?.price ?? 0) > 0)) ? 'Укажите цену (> 0) у каждого варианта'
    : isPurchased && combosOf(attrs).some(c => !((prices[c.key]?.purchase ?? 0) > 0)) ? 'Укажите закупку (> 0) у каждого варианта'
    : ''

  const handleSave = async () => {
    if (saving) return
    setSaving(true)
    try {
      // Сначала — конвертация в покупной (если форма её подразумевает, а бэк
      // ещё нет): иначе syncVariants проигнорирует закупку по вариациям.
      if (isPurchased) {
        await onEnsurePurchased?.()
      }
      const state = await syncMenuAttributes(
        productId,
        attrs.map(a => ({
          id: a.id,
          name: a.name.trim(),
          sizeScaleId: a.sizeScaleId,
          values: a.values.map(v => ({ id: v.id, label: v.label.trim() })),
        })),
        buildCombosPayload(attrs, prices),
      )
      setAttrs(state.attributes.map(a => ({
        id: a.id,
        name: a.name,
        sizeScaleId: a.sizeScaleId ?? undefined,
        values: a.values.map(v => ({ id: v.id, label: v.label })),
      })))
      setVariants(state.variants)
      setDirty(false)
      onHasAttributesChange?.(state.attributes.length > 0)
      onVariantsChange?.(state.attributes, state.variants)
      toast.success(state.variants.length > 0
        ? `Варианты обновлены: ${state.variants.length}`
        : 'Атрибуты удалены — товар снова обычный')
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка сохранения атрибутов'))
    } finally {
      setSaving(false)
    }
  }

  const handleToggleVariant = async (v: MenuItem) => {
    try {
      await toggleMenuAvailability(v.id, !v.isAvailable)
      setVariants(prev => prev.map(x => x.id === v.id ? { ...x, isAvailable: !v.isAvailable } : x))
    } catch {
      toast.error('Не удалось изменить доступность')
    }
  }

  if (loading) return null

  return (
    <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-1.5">
          <Layers className="size-4 text-primary" />
          Атрибуты и варианты
        </h2>
        {attrs.length > 0 && (
          <button
            type="button"
            onClick={handleSave}
            disabled={!canSave}
            title={saveDisabledReason || undefined}
            className="px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            {saving ? 'Сохранение...' : 'Сохранить варианты'}
          </button>
        )}
      </div>

      {dirty && saveDisabledReason && (
        <p className="text-xs font-medium text-amber-600">Нельзя сохранить варианты: {saveDisabledReason}</p>
      )}

      {attrs.length === 0 && (
        <p className="text-xs text-muted-foreground leading-relaxed">
          Один товар в нескольких размерах или вкусах? Добавьте атрибут
          (например «Размер»: 1 л / 1.5 л) и укажите цену каждого варианта —
          система сама создаст их{isPurchased ? ' с отдельным складским учётом' : ''}.
          На кассе останется одна карточка товара с выбором.
        </p>
      )}

      <AttributesForm attrs={attrs} onChange={next => { setAttrs(next); setDirty(true) }} />
      <ComboPricesEditor
        attrs={attrs}
        prices={prices}
        showPurchase={isPurchased}
        onChange={next => { setPrices(next); setDirty(true) }}
      />

      {variants.length > 0 && (
        <div className="pt-3 border-t border-border space-y-1.5">
          <span className="text-xs font-bold text-foreground">Доступность на кассе</span>
          {variants.map(v => (
            <div key={v.id} className="flex items-center gap-2 px-3 py-2 bg-muted/20 border border-border/50 rounded-lg">
              <span className="flex-1 text-sm font-medium text-foreground truncate">{v.name}</span>
              <span className="text-sm font-bold text-foreground tabular-nums">{v.price}</span>
              <button
                type="button"
                onClick={() => handleToggleVariant(v)}
                className={`px-2 py-0.5 text-[10px] font-bold rounded-full border transition-colors ${v.isAvailable
                  ? 'bg-emerald-500/10 text-emerald-600 border-emerald-500/30'
                  : 'bg-muted text-muted-foreground border-border'}`}
              >
                {v.isAvailable ? 'Доступен' : 'Скрыт'}
              </button>
            </div>
          ))}
          {isPurchased && (
            <p className="text-[10px] text-muted-foreground leading-relaxed pt-1">
              У каждого варианта — свой складской товар с таким же названием:
              приёмка и остатки ведутся раздельно (Склад → Ингредиенты).
            </p>
          )}
          {dirty && <p className="text-[10px] text-amber-600 font-medium">Есть несохранённые изменения атрибутов.</p>}
        </div>
      )}
    </div>
  )
}
