'use client'

import { useState, useEffect, useCallback } from 'react'
import { formatCurrency, getTimeSince } from '@/lib/helpers'
import { useAuth } from '@/lib/auth-store'
import { type SemiFinishedStock, type MenuItem, type Ingredient, type StockWriteoff, type WriteoffReason, WRITEOFF_REASON_LABELS } from '@/lib/types'
import { fetchSemiStock, fetchMenuItems, fetchIngredients, fetchWriteoffs, createWriteoff } from '@/lib/queries'
import { PackageCheck, FlaskConical, UtensilsCrossed, Trash2, Minus, Plus, X, History } from 'lucide-react'
import { DishImage } from '@/components/dish-image'
import { toast } from 'sonner'
import { api, unwrap } from '@/lib/api'

const WRITEOFF_REASONS: { value: WriteoffReason; label: string }[] = [
  { value: 'spoilage', label: 'Порча' },
  { value: 'expired', label: 'Просрочка' },
  { value: 'breakage', label: 'Бой' },
  { value: 'tasting', label: 'Дегустация' },
  { value: 'other', label: 'Прочее' },
]

export default function ShowcasePage() {
  const { user } = useAuth()
  const [semiStock, setSemiStock] = useState<SemiFinishedStock[]>([])
  const [showcaseItems, setShowcaseItems] = useState<MenuItem[]>([])
  const [ingredients, setIngredients] = useState<Ingredient[]>([])
  const [writeoffs, setWriteoffs] = useState<StockWriteoff[]>([])
  const [loading, setLoading] = useState(true)

  // Writeoff modal (works for both showcase items and semi-finished)
  const [writeoffTarget, setWriteoffTarget] = useState<{ type: 'menu' | 'semi'; name: string; id: string; unit: string } | null>(null)
  const [writeoffQty, setWriteoffQty] = useState(1)
  const [writeoffReason, setWriteoffReason] = useState<WriteoffReason>('spoilage')
  const [writeoffDesc, setWriteoffDesc] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const reload = useCallback(() => {
    return Promise.all([fetchSemiStock(), fetchMenuItems(), fetchIngredients(), fetchWriteoffs()])
      .then(([stock, menuItems, ings, woffs]) => {
        setSemiStock(stock)
        setShowcaseItems(menuItems.filter(m => m.station === 'showcase' && m.isAvailable))
        setIngredients(ings)
        // Show only recent writeoffs (last 30 days)
        const thirtyDaysAgo = Date.now() - 30 * 24 * 60 * 60 * 1000
        setWriteoffs(woffs.filter(w => new Date(w.createdAt).getTime() > thirtyDaysAgo).slice(0, 20))
      })
  }, [])

  useEffect(() => {
    reload().finally(() => setLoading(false))
  }, [reload])

  const openWriteoff = (type: 'menu' | 'semi', name: string, id: string, unit: string) => {
    setWriteoffTarget({ type, name, id, unit })
    setWriteoffQty(1)
    setWriteoffReason('spoilage')
    setWriteoffDesc('')
  }

  const handleWriteoff = async () => {
    if (!writeoffTarget || writeoffQty <= 0) return
    setSubmitting(true)
    try {
      if (writeoffTarget.type === 'menu') {
        // Showcase item → find matching ingredient and create writeoff
        const matchedIng = ingredients.find(i => i.name.toLowerCase() === writeoffTarget.name.toLowerCase())
        if (matchedIng) {
          await createWriteoff({
            reason: writeoffReason,
            description: writeoffDesc || `Списание с витрины: ${writeoffTarget.name}`,
            lines: [{
              ingredientId: matchedIng.id,
              name: matchedIng.name,
              qty: writeoffQty,
              unit: matchedIng.unit,
              pricePerUnit: matchedIng.pricePerUnit,
            }],
            createdBy: user?.id,
          })
          toast.success(`Списано: ${writeoffTarget.name} × ${writeoffQty}`)
        } else {
          toast.error(`Ингредиент «${writeoffTarget.name}» не найден на складе`)
        }
      } else {
        // Semi-finished → decrement qty directly + create writeoff record
        const semi = semiStock.find(s => s.id === writeoffTarget.id)
        if (semi) {
          // v4: consume the semi-finished portion through the canonical endpoint.
          // Server clamps to 0 and writes the stock movement.
          await unwrap(api.POST('/api/v1/semi/consume', {
            body: { semi_type_id: semi.semiTypeId, qty: String(writeoffQty) } as any,
          }))
          // Create writeoff record for history
          await createWriteoff({
            reason: writeoffReason,
            description: writeoffDesc || `Списание полуфабриката: ${writeoffTarget.name}`,
            lines: [{
              ingredientId: semi.id,
              name: semi.name,
              qty: writeoffQty,
              unit: semi.unit,
              pricePerUnit: semi.pricePerUnit,
            }],
            createdBy: user?.id,
          })
          toast.success(`Списано: ${writeoffTarget.name} × ${writeoffQty} ${semi.unit}`)
        }
      }
      setWriteoffTarget(null)
      await reload()
    } catch (e) {
      toast.error(e instanceof Error ? e.message : 'Ошибка списания')
    } finally {
      setSubmitting(false)
    }
  }

  if (loading) return <div className="p-6 flex items-center justify-center h-64"><div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" /></div>

  return (
    <div className="p-4 md:p-6 space-y-5 md:space-y-6">
      <div>
        <h1 className="text-xl font-bold text-foreground">Витрина и раздача</h1>
        <p className="text-muted-foreground text-sm mt-0.5">Готовые блюда, полуфабрикаты и история списаний</p>
      </div>

      {/* Showcase station dishes */}
      {showcaseItems.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            <UtensilsCrossed className="size-3.5 inline mr-1.5" />Блюда витрины
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
            {showcaseItems.map(item => {
              const matchedIng = ingredients.find(i => i.name.toLowerCase() === item.name.toLowerCase())
              const stock = matchedIng ? matchedIng.qty : null
              const stockLow = matchedIng ? matchedIng.qty <= matchedIng.minQty : false
              return (
                <div key={item.id} className="bg-card rounded-xl border border-border p-4 space-y-3">
                  <div className="flex items-center gap-3">
                    <DishImage imageUrl={item.imageUrl} emoji={item.emoji} name={item.name} size="sm" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-foreground text-sm truncate">{item.name}</p>
                      <p className="text-xs text-muted-foreground">{item.category}</p>
                    </div>
                    <div className="text-right shrink-0">
                      <p className="text-sm font-bold text-foreground">{formatCurrency(item.price)}</p>
                      {stock !== null && (
                        <p className={`text-xs font-medium ${stockLow ? 'text-red-500' : 'text-emerald-600'}`}>
                          {stock} {matchedIng?.unit || 'шт.'}
                        </p>
                      )}
                    </div>
                  </div>
                  <button
                    onClick={() => openWriteoff('menu', item.name, item.id, matchedIng?.unit || 'шт.')}
                    className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 transition-colors border border-red-200"
                  >
                    <Trash2 className="size-3.5" />
                    Списать
                  </button>
                </div>
              )
            })}
          </div>
        </div>
      )}

      {showcaseItems.length === 0 && semiStock.length === 0 && (
        <div className="bg-card rounded-xl border border-border p-8 text-center">
          <PackageCheck className="size-10 text-muted-foreground/30 mx-auto mb-3" />
          <p className="font-medium text-foreground">Нет блюд на витрине</p>
          <p className="text-sm text-muted-foreground mt-1">Добавьте блюда со станцией &quot;Витрина&quot; в разделе Меню</p>
        </div>
      )}

      {/* Semi-finished stock */}
      {semiStock.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            <FlaskConical className="size-3.5 inline mr-1.5" />Полуфабрикаты
          </h2>
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3 md:gap-4">
            {semiStock.map(s => (
              <div key={s.id} className="bg-card rounded-xl border border-border p-4 space-y-3">
                <div className="flex items-center gap-2">
                  <FlaskConical className="size-4 text-primary shrink-0" />
                  <span className="font-semibold text-foreground text-sm flex-1">{s.name}</span>
                </div>
                <div className="flex items-baseline gap-1">
                  <span className={`text-3xl font-bold ${s.qty <= 0 ? 'text-red-500' : 'text-foreground'}`}>{s.qty}</span>
                  <span className="text-sm text-muted-foreground">{s.unit}</span>
                </div>
                {s.pricePerUnit > 0 && (
                  <p className="text-xs text-foreground">
                    Себест.: <span className="font-semibold">{formatCurrency(s.pricePerUnit)}</span>/{s.unit}
                  </p>
                )}
                {s.lastProducedAt && (
                  <p className="text-xs text-muted-foreground">
                    Пр-во: {new Date(s.lastProducedAt).toLocaleDateString('ru')} {new Date(s.lastProducedAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })}
                  </p>
                )}
                <button
                  onClick={() => openWriteoff('semi', s.name, s.id, s.unit)}
                  disabled={s.qty <= 0}
                  className="w-full flex items-center justify-center gap-1.5 px-3 py-2 rounded-lg text-xs font-medium text-red-600 bg-red-50 hover:bg-red-100 transition-colors border border-red-200 disabled:opacity-30 disabled:cursor-not-allowed"
                >
                  <Trash2 className="size-3.5" />
                  Списать
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Writeoff History */}
      {writeoffs.length > 0 && (
        <div>
          <h2 className="text-sm font-semibold text-muted-foreground uppercase tracking-wide mb-3">
            <History className="size-3.5 inline mr-1.5" />История списаний (30 дней)
          </h2>
          <div className="bg-card rounded-xl border border-border divide-y divide-border overflow-hidden">
            {writeoffs.map(w => (
              <div key={w.id} className="px-4 py-3 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3 min-w-0">
                  <div className="size-8 rounded-lg bg-red-50 flex items-center justify-center shrink-0">
                    <Trash2 className="size-3.5 text-red-500" />
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2">
                      <span className={`text-[10px] font-medium px-1.5 py-0.5 rounded ${
                        w.reason === 'spoilage' ? 'bg-red-100 text-red-700' :
                        w.reason === 'expired' ? 'bg-amber-100 text-amber-700' :
                        w.reason === 'tasting' ? 'bg-blue-100 text-blue-700' :
                        'bg-muted text-muted-foreground'
                      }`}>
                        {WRITEOFF_REASON_LABELS[w.reason] || w.reason}
                      </span>
                      <span className="text-sm font-medium text-foreground truncate">
                        {w.lines.length > 0 ? w.lines.map(l => `${l.name} ×${l.qty}`).join(', ') : 'Без позиций'}
                      </span>
                    </div>
                    {w.description && (
                      <p className="text-xs text-muted-foreground truncate mt-0.5">{w.description}</p>
                    )}
                  </div>
                </div>
                <div className="text-right shrink-0">
                  <p className="text-sm font-semibold text-red-600">{formatCurrency(w.totalCost)}</p>
                  <p className="text-[10px] text-muted-foreground">{getTimeSince(w.createdAt)}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Writeoff Modal */}
      {writeoffTarget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50" onClick={() => setWriteoffTarget(null)}>
          <div className="bg-card rounded-2xl border border-border p-6 w-full max-w-sm space-y-4 shadow-2xl" onClick={e => e.stopPropagation()}>
            <div className="flex items-center justify-between">
              <h3 className="font-bold text-foreground">
                {writeoffTarget.type === 'semi' ? 'Списание полуфабриката' : 'Списание с витрины'}
              </h3>
              <button onClick={() => setWriteoffTarget(null)} className="p-1 rounded-lg hover:bg-muted"><X className="size-4" /></button>
            </div>
            <p className="text-sm text-muted-foreground">{writeoffTarget.name}</p>

            {/* Qty */}
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Количество ({writeoffTarget.unit})</label>
              <div className="flex items-center gap-3">
                <button onClick={() => setWriteoffQty(Math.max(0.5, writeoffQty - (writeoffTarget.type === 'semi' ? 0.5 : 1)))} className="size-10 rounded-lg bg-muted flex items-center justify-center hover:bg-muted/80"><Minus className="size-4" /></button>
                <input type="number" min={0.1} step={writeoffTarget.type === 'semi' ? 0.5 : 1} value={writeoffQty} onChange={e => setWriteoffQty(Math.max(0.1, Number(e.target.value)))}
                  className="w-20 text-center text-lg font-bold bg-background border border-border rounded-lg py-2" />
                <button onClick={() => setWriteoffQty(writeoffQty + (writeoffTarget.type === 'semi' ? 0.5 : 1))} className="size-10 rounded-lg bg-muted flex items-center justify-center hover:bg-muted/80"><Plus className="size-4" /></button>
              </div>
            </div>

            {/* Reason */}
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Причина</label>
              <div className="flex flex-wrap gap-1.5">
                {WRITEOFF_REASONS.map(r => (
                  <button key={r.value} onClick={() => setWriteoffReason(r.value)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors ${writeoffReason === r.value ? 'bg-red-600 text-white border-red-600' : 'bg-card border-border hover:bg-muted'}`}>
                    {r.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Description */}
            <div>
              <label className="text-xs text-muted-foreground block mb-1">Описание (необязательно)</label>
              <input value={writeoffDesc} onChange={e => setWriteoffDesc(e.target.value)} placeholder="Подробности..."
                className="w-full px-3 py-2 bg-background border border-border rounded-lg text-sm" />
            </div>

            {/* Submit */}
            <button onClick={handleWriteoff} disabled={submitting}
              className="w-full px-4 py-3 rounded-xl text-sm font-medium text-white bg-red-600 hover:bg-red-700 disabled:opacity-50 flex items-center justify-center gap-2">
              <Trash2 className="size-4" />
              {submitting ? 'Списание...' : `Списать ${writeoffQty} ${writeoffTarget.unit}`}
            </button>
          </div>
        </div>
      )}
    </div>
  )
}
