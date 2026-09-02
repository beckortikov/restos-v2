'use client'

// Утверждение табеля за период.
//
// До этого «утверждённой суммы» не существовало: начисление считалось на лету,
// и правка отметки задним числом молча меняла уже показанную цифру. Здесь
// период фиксируется, а расхождения показываются — но не блокируются:
// запретить правку значило бы, что забытый уход исправить нельзя вовсе.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { AlertTriangle, Check, Loader2, Lock, LockOpen } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import {
  approveTimesheet, cancelApproval, fetchApproval, type ApprovalStatus,
} from '@/lib/queries/schedule'
import { humanizeError } from '@/lib/errors'
import { formatCurrency } from '@/lib/helpers'
import { EmptyHint } from './shared'

/** Первое и последнее число месяца, в котором лежит дата. */
function monthBounds(d: Date): { from: string; to: string } {
  const y = d.getFullYear()
  const m = d.getMonth()
  const pad = (n: number) => String(n).padStart(2, '0')
  const last = new Date(y, m + 1, 0).getDate()
  return { from: `${y}-${pad(m + 1)}-01`, to: `${y}-${pad(m + 1)}-${pad(last)}` }
}

export function ApprovalPanel() {
  const [range, setRange] = useState(() => monthBounds(new Date()))
  const [status, setStatus] = useState<ApprovalStatus | null>(null)
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setStatus(await fetchApproval(range.from, range.to))
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setLoading(false)
    }
  }, [range])

  useEffect(() => { void load() }, [load])

  const worked = useMemo(
    () => (status?.rows ?? []).filter((r) => r.currentDays > 0 || r.approvedDays > 0),
    [status],
  )

  const act = async (fn: () => Promise<unknown>, ok: string) => {
    setBusy(true)
    try {
      await fn()
      toast.success(ok)
      await load()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Input
          type="date"
          value={range.from}
          onChange={(e) => setRange((r) => ({ ...r, from: e.target.value }))}
          className="w-40"
        />
        <span className="text-muted-foreground">—</span>
        <Input
          type="date"
          value={range.to}
          onChange={(e) => setRange((r) => ({ ...r, to: e.target.value }))}
          className="w-40"
        />
        <Button variant="outline" size="sm" onClick={() => setRange(monthBounds(new Date()))}>
          Текущий месяц
        </Button>

        <div className="flex-1" />

        {status?.approved ? (
          <Button
            variant="outline"
            size="sm"
            disabled={busy}
            onClick={() => void act(() => cancelApproval(range.from, range.to), 'Период переоткрыт')}
          >
            <LockOpen className="w-4 h-4 mr-1.5" /> Переоткрыть
          </Button>
        ) : (
          <Button
            size="sm"
            disabled={busy || loading}
            onClick={() => void act(() => approveTimesheet(range.from, range.to), 'Табель утверждён')}
          >
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <><Lock className="w-4 h-4 mr-1.5" /> Утвердить табель</>}
          </Button>
        )}
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Загружаем…
        </div>
      ) : !status ? null : (
        <>
          {status.approved ? (
            <div
              className={`rounded-xl border px-4 py-3 flex flex-wrap items-center gap-x-4 gap-y-1 ${
                status.changedCount > 0
                  ? 'border-amber-500/40 bg-amber-500/5'
                  : 'border-emerald-500/30 bg-emerald-500/5'
              }`}
            >
              {status.changedCount > 0 ? (
                <AlertTriangle className="w-4 h-4 text-amber-600 dark:text-amber-400 shrink-0" />
              ) : (
                <Check className="w-4 h-4 text-emerald-600 dark:text-emerald-400 shrink-0" />
              )}
              <div className="text-sm">
                <b>Утверждено {formatCurrency(status.totalAccrued)}</b>
                {status.approvedByName && ` · ${status.approvedByName}`}
                {status.approvedAt && ` · ${new Date(status.approvedAt).toLocaleDateString('ru-RU')}`}
              </div>
              {status.changedCount > 0 && (
                <div className="text-sm text-amber-700 dark:text-amber-400">
                  После утверждения данные изменились у {status.changedCount} чел. — суммы ниже остались прежними.
                  Чтобы пересогласовать, переоткройте период.
                </div>
              )}
            </div>
          ) : (
            <div className="rounded-xl border px-4 py-3 text-sm text-muted-foreground">
              Период не утверждён: суммы пересчитываются на лету и меняются при любой правке отметок.
              Утвердите его, когда табель проверен.
            </div>
          )}

          {worked.length === 0 ? (
            <EmptyHint text="За период нет ни отработанных дней, ни начислений." />
          ) : (
            <div className="border rounded-xl overflow-hidden bg-card">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[640px]">
                  <thead>
                    <tr className="bg-muted/40 text-muted-foreground">
                      <th className="text-left font-medium px-4 py-2.5">Сотрудник</th>
                      <th className="text-right font-medium px-3 py-2.5">Дни</th>
                      <th className="text-right font-medium px-3 py-2.5">Часы</th>
                      <th className="text-right font-medium px-4 py-2.5">Начислено</th>
                    </tr>
                  </thead>
                  <tbody>
                    {worked.map((row) => (
                      <tr key={row.userId} className={`border-t ${row.changed ? 'bg-amber-500/[0.06]' : ''}`}>
                        <td className="px-4 py-2.5">
                          <div className="font-medium">{row.userName || '—'}</div>
                          {row.changed && (
                            <div className="text-xs text-amber-700 dark:text-amber-400">изменилось после утверждения</div>
                          )}
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <Cell approved={status.approved} a={row.approvedDays} c={row.currentDays} />
                        </td>
                        <td className="px-3 py-2.5 text-right tabular-nums">
                          <Cell approved={status.approved} a={row.approvedHours} c={row.currentHours} suffix=" ч" />
                        </td>
                        <td className="px-4 py-2.5 text-right tabular-nums font-medium">
                          <Cell
                            approved={status.approved}
                            a={row.approvedAccrued}
                            c={row.currentAccrued}
                            money
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="px-4 py-2.5 bg-muted/20 border-t text-xs text-muted-foreground">
                {status.approved
                  ? 'Показаны утверждённые значения. Где они разошлись с текущими — рядом стоит новое число.'
                  : 'Значения пересчитываются на лету: пока период не утверждён, они меняются вместе с отметками.'}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

/**
 * Ячейка «утверждено → стало». Пока период не утверждён, показываем просто
 * текущее значение: две одинаковые цифры рядом только сбивают.
 */
function Cell({
  approved, a, c, money, suffix = '',
}: {
  approved: boolean
  a: number
  c: number
  money?: boolean
  suffix?: string
}) {
  const fmt = (v: number) => (money ? formatCurrency(v) : `${v}${suffix}`)
  if (!approved) return <span>{fmt(c)}</span>
  if (a === c) return <span>{fmt(a)}</span>
  return (
    <span>
      {fmt(a)}
      <span className="text-amber-700 dark:text-amber-400"> → {fmt(c)}</span>
    </span>
  )
}
