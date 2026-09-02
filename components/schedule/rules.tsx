'use client'

// Правила учёта времени: допуск опоздания, штрафы, и (позже) округление смены
// и норма дня. Раньше жили в модальном окне поверх переклички — но это не
// разовое действие, а настройки модуля, и прятать их за кнопкой значило, что
// про них не знают.

import { useEffect, useMemo, useState } from 'react'
import { Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { fetchRestaurantById, updateRestaurant } from '@/lib/queries'
import { useAuth } from '@/lib/auth-store'
import { humanizeError } from '@/lib/errors'
import { formatCurrency } from '@/lib/helpers'


/**
 * Правила опозданий (105). Формула показана явно и пересчитывается на живом
 * примере: «10 + 2 × 23 = 56 с.» понятнее любого описания, а без примера
 * человек не видит, во что превращается ставка за минуту на реальном
 * опоздании.
 */
export function RulesPanel({ onSaved }: { onSaved?: () => void }) {
  const { restaurantId } = useAuth()
  const [grace, setGrace] = useState('5')
  const [fixed, setFixed] = useState('0')
  const [perMinute, setPerMinute] = useState('0')
  const [max, setMax] = useState('0')
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        const r = restaurantId ? await fetchRestaurantById(restaurantId) : null
        if (!alive || !r) return
        setGrace(String(r.lateGraceMinutes ?? 5))
        setFixed(String(r.lateFineFixed ?? 0))
        setPerMinute(String(r.lateFinePerMinute ?? 0))
        setMax(String(r.lateFineMax ?? 0))
      } catch (e) {
        toast.error(humanizeError(e))
      } finally {
        if (alive) setLoading(false)
      }
    })()
    return () => { alive = false }
  }, [restaurantId])

  // Пример на опоздании в 30 минут — типичное «проспал», а не крайний случай.
  const example = useMemo(() => {
    const g = Number(grace) || 0
    const f = Number(fixed) || 0
    const pm = Number(perMinute) || 0
    const cap = Number(max) || 0
    const late = 30
    const over = Math.max(0, late - g)
    let sum = over > 0 ? f + pm * over : 0
    const capped = cap > 0 && sum > cap
    if (capped) sum = cap
    return { late, over, sum, capped, configured: f > 0 || pm > 0 }
  }, [grace, fixed, perMinute, max])

  const save = async () => {
    if (!restaurantId) return
    setSaving(true)
    try {
      await updateRestaurant(restaurantId, {
        lateGraceMinutes: Number(grace) || 0,
        lateFineFixed: fixed,
        lateFinePerMinute: perMinute,
        lateFineMax: max,
      })
      toast.success('Правила сохранены')
      onSaved?.()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="max-w-2xl space-y-4">
      <div className="border rounded-xl bg-card p-4 md:p-5 space-y-4">
        <div>
          <h2 className="text-base font-semibold">Опоздания и штрафы</h2>
          <p className="text-sm text-muted-foreground">
            Штраф = фиксированно + за минуту × (минуты опоздания − допуск), но не больше потолка.
          </p>
        </div>

        {loading ? (
          <div className="flex justify-center py-8"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        ) : (
          <div className="space-y-4">
            <div className="space-y-3">
              <RuleField
                label="Допуск"
                hint="Опоздание в пределах допуска не считается опозданием"
                suffix="мин"
                value={grace}
                onChange={setGrace}
              />
              <RuleField
                label="Фиксированно за опоздание"
                hint="Разово, за сам факт"
                suffix="с."
                value={fixed}
                onChange={setFixed}
              />
              <RuleField
                label="За каждую минуту сверх допуска"
                suffix="с."
                value={perMinute}
                onChange={setPerMinute}
              />
              <RuleField
                label="Потолок штрафа"
                hint="0 — без потолка"
                suffix="с."
                value={max}
                onChange={setMax}
              />
            </div>

            <div className="rounded-lg border px-3 py-2.5 text-sm bg-muted/20">
              <div className="text-xs text-muted-foreground mb-1">Например, опоздание на {example.late} мин</div>
              {example.configured ? (
                <div className="flex items-baseline gap-2">
                  <span className="text-lg font-semibold">{formatCurrency(example.sum)}</span>
                  <span className="text-xs text-muted-foreground">
                    {example.over > 0
                      ? <>{fixed || 0} + {perMinute || 0} × {example.over} мин{example.capped ? ' → потолок' : ''}</>
                      : 'в пределах допуска — без штрафа'}
                  </span>
                </div>
              ) : (
                <div className="text-sm text-muted-foreground">
                  Суммы не заданы — опоздания показываются, но штрафовать система не предложит.
                </div>
              )}
            </div>

            <p className="text-xs text-muted-foreground">
              Штраф не списывается сам: система считает сумму, а удерживает её кнопкой человек — время на планшете
              может сбиться, а уход накануне остаться неотмеченным.
            </p>

            <div className="flex justify-end">
              <Button onClick={save} disabled={saving}>
                {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : 'Сохранить'}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  )
}

function RuleField({
  label, hint, suffix, value, onChange,
}: {
  label: string
  hint?: string
  suffix: string
  value: string
  onChange: (v: string) => void
}) {
  return (
    <div className="flex items-center justify-between gap-3">
      <div className="min-w-0">
        <div className="text-sm">{label}</div>
        {hint && <div className="text-xs text-muted-foreground">{hint}</div>}
      </div>
      <div className="relative shrink-0">
        <Input
          value={value}
          onChange={(e) => onChange(e.target.value)}
          inputMode="decimal"
          className="w-32 pr-9 text-right"
        />
        {/* Единица внутри поля, а не подписью рядом: иначе непонятно, вводить
            сомони или проценты, и в узком диалоге подпись уезжает на строку ниже. */}
        <span className="absolute right-3 top-1/2 -translate-y-1/2 text-xs text-muted-foreground pointer-events-none">
          {suffix}
        </span>
      </div>
    </div>
  )
}
