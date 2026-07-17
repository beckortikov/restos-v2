'use client'

import { useState, useEffect, useMemo } from 'react'
import { Layers } from 'lucide-react'
import { toast } from 'sonner'
import type { MenuItem, MenuAttribute, Ingredient, SemiFinishedType, TechCardLine } from '@/lib/types'
import { fetchTechCardLines, replaceTechCardLines } from '@/lib/queries'
import { humanizeError } from '@/lib/errors'
import { TechCardLinesEditor, emptyTechLine } from './tech-card-lines-editor'

// VariantTechCardsEditor — техкарта у КАЖДОГО размерного варианта отдельно:
// «Пепперони 25/30/35» списывают разные граммовки, а не одну техкарту
// продукта-родителя. Бэк уже хранит их независимо (tech_card_lines.menu_item_id
// = id варианта) — здесь только недостающая админ-UI поверх него.
//
// Строки каждого варианта держим в памяти по id (linesByVariant), а не
// перезапрашиваем с бэка при каждом переключении таба — иначе несохранённые
// правки в табе A молча терялись при переходе в таб B. «Сохранить техкарту»
// одной кнопкой сохраняет ВСЕ табы, которые успели загрузиться в этой сессии
// редактирования (а не только текущий) — по той же причине.
export function VariantTechCardsEditor({ variants, ingredients, semiTypes, productAttributes }: {
  variants: MenuItem[]
  ingredients: Ingredient[]
  semiTypes: SemiFinishedType[]
  productAttributes: MenuAttribute[]
}) {
  const [selectedId, setSelectedId] = useState(variants[0]?.id ?? '')
  const [linesByVariant, setLinesByVariant] = useState<Record<string, TechCardLine[]>>({})
  const [loadingId, setLoadingId] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    if (!selectedId || linesByVariant[selectedId]) return
    setLoadingId(selectedId)
    fetchTechCardLines(selectedId)
      .then(l => setLinesByVariant(prev => ({ ...prev, [selectedId]: l.length > 0 ? l : [{ ...emptyTechLine }] })))
      .catch(() => setLinesByVariant(prev => ({ ...prev, [selectedId]: [{ ...emptyTechLine }] })))
      .finally(() => setLoadingId(null))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const selectedVariant = variants.find(v => v.id === selectedId)
  const lines = linesByVariant[selectedId] ?? []

  // Значения шкалы размеров (sizeScaleValueId), к которым относится выбранный
  // вариант — по ним подсвечиваем подходящую заготовку в комбобоксе (§3.2:
  // «Пепперони 30» обязана списывать «Тесто 30», а не «Тесто 25»).
  const matchingSemiIds = useMemo(() => {
    if (!selectedVariant) return undefined
    const valueIds = new Set(selectedVariant.variantValueIds ?? [])
    if (valueIds.size === 0) return undefined
    const ids = new Set<string>()
    for (const attr of productAttributes) {
      for (const v of attr.values) {
        if (valueIds.has(v.id) && v.sizeScaleValueId) ids.add(v.sizeScaleValueId)
      }
    }
    return ids.size > 0 ? ids : undefined
  }, [selectedVariant, productAttributes])

  const handleSave = async () => {
    const loadedIds = Object.keys(linesByVariant)
    if (loadedIds.length === 0 || saving) return
    setSaving(true)
    try {
      await Promise.all(loadedIds.map(id =>
        replaceTechCardLines(id, linesByVariant[id].filter(l => l.ingredientId || l.semiId))
      ))
      toast.success(loadedIds.length > 1 ? `Техкарты сохранены: ${loadedIds.length}` : 'Техкарта варианта сохранена')
    } catch (e) {
      toast.error(humanizeError(e, 'Ошибка сохранения техкарты'))
    } finally {
      setSaving(false)
    }
  }

  if (variants.length === 0) return null

  return (
    <div className="bg-card border border-border rounded-xl p-5 shadow-sm space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-bold text-foreground flex items-center gap-1.5">
          <Layers className="size-4 text-primary" />
          Техкарты по вариантам
        </h2>
        <button
          type="button"
          onClick={handleSave}
          disabled={saving || loadingId !== null}
          className="px-3 py-1.5 text-xs font-semibold bg-primary text-primary-foreground rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50"
        >
          {saving ? 'Сохранение...' : 'Сохранить техкарту'}
        </button>
      </div>

      <p className="text-xs text-muted-foreground leading-relaxed">
        У каждого размера — своя техкарта: граммовки не масштабируются линейно,
        задайте их отдельно для каждого варианта. Переключение между размерами
        не сбрасывает правки — «Сохранить техкарту» сохранит все открытые вкладки разом.
      </p>

      <div className="flex flex-wrap gap-1.5">
        {variants.map(v => (
          <button
            key={v.id}
            type="button"
            onClick={() => setSelectedId(v.id)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${selectedId === v.id
              ? 'bg-primary text-primary-foreground border-primary'
              : 'bg-muted/30 border-border text-foreground hover:bg-muted'}`}
          >
            {v.name}
          </button>
        ))}
      </div>

      {loadingId === selectedId ? (
        <div className="flex justify-center py-6"><div className="size-5 border-2 border-primary/30 border-t-primary rounded-full animate-spin" /></div>
      ) : (
        <TechCardLinesEditor
          lines={lines}
          onChange={next => setLinesByVariant(prev => ({ ...prev, [selectedId]: next }))}
          ingredients={ingredients}
          semiTypes={semiTypes}
          matchingSemiIds={matchingSemiIds}
        />
      )}
    </div>
  )
}
