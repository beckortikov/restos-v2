'use client'

// Обзор смены: план против факта за день, снимки отметок и штрафы.

import { useEffect, useState } from 'react'
import { Camera, Check, Loader2, Users } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import {
  fetchAttendancePhoto, fineLate,
  type RollCallReport, type RollCallRow,
} from '@/lib/queries/schedule'
import { humanizeError } from '@/lib/errors'
import { formatCurrency } from '@/lib/helpers'
import {
  EmptyHint, ROW_ACCENT, ROW_TONE, STATUS_LABEL, STATUS_TONE, addDays, timeOf, ymd,
} from './shared'




// Строки-исключения подсвечиваем целиком, а не одним бейджем: смысл экрана —
// с одного взгляда увидеть, где не так, не вчитываясь в каждую строку.

// Цветная полоса слева — тот же сигнал для тех, кто различает не оттенки, а
// форму, и для печати в ч/б.

export function RollCallView({
  date, onDate, report, loading, canFine, onReload,
}: {
  date: string
  onDate: (d: string) => void
  report: RollCallReport | null
  loading: boolean
  /** В режиме просмотра филиала штраф не выставляем: удержание пишется в
   *  свою БД, а не в филиальскую — оно ушло бы не тому. */
  canFine: boolean
  onReload: () => void
}) {
  const [photoFor, setPhotoFor] = useState<RollCallRow | null>(null)
  const [finingId, setFiningId] = useState<string | null>(null)

  const applyFine = async (row: RollCallRow) => {
    setFiningId(row.userId)
    try {
      await fineLate(row.userId, date)
      toast.success(`Удержано ${row.suggestedFine} · ${row.userName}`)
      onReload()
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setFiningId(null)
    }
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onDate(addDays(date, -1))} aria-label="Предыдущий день">←</Button>
        <Input
          type="date"
          value={date}
          onChange={(e) => onDate(e.target.value)}
          className="w-44"
        />
        <Button variant="outline" size="sm" onClick={() => onDate(addDays(date, 1))} aria-label="Следующий день">→</Button>
        <Button variant="outline" size="sm" onClick={() => onDate(ymd(new Date()))}>Сегодня</Button>
        <div className="flex-1" />
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Считаем перекличку…
        </div>
      ) : !report ? null : (
        <>
          <div className="grid grid-cols-2 md:grid-cols-5 gap-2">
            <Stat label="По графику" value={report.planned} icon={<Users className="w-4 h-4" />} />
            <Stat label="Пришли" value={report.present} tone="text-emerald-600 dark:text-emerald-400" />
            <Stat label="Опоздали" value={report.late} tone="text-amber-600 dark:text-amber-400" />
            <Stat label="Не пришли" value={report.absent} tone="text-red-600 dark:text-red-400" />
            <Stat label="Без графика" value={report.unplanned} tone="text-sky-600 dark:text-sky-400" />
          </div>

          {report.rows.length === 0 ? (
            <EmptyHint text="На этот день нет ни плановых смен, ни отметок." />
          ) : (
            <div className="border rounded-xl overflow-hidden bg-card">
              <div className="overflow-x-auto">
                <table className="w-full text-sm min-w-[720px]">
                  <thead>
                    <tr className="bg-muted/40 text-muted-foreground">
                      <th className="text-left font-medium px-3 py-2.5 w-[34%]">Сотрудник</th>
                      <th className="text-left font-medium px-3 py-2.5">По графику</th>
                      <th className="text-left font-medium px-3 py-2.5">Пришёл / ушёл</th>
                      <th className="text-left font-medium px-3 py-2.5">Статус</th>
                      <th className="text-right font-medium px-3 py-2.5 w-44">Штраф</th>
                    </tr>
                  </thead>
                  <tbody>
                    {report.rows.map((row) => (
                      <tr
                        key={row.userId}
                        className={`border-t transition-colors hover:bg-muted/40 ${ROW_TONE[row.status]}`}
                      >
                        <td className="px-0 py-2.5">
                          <div className="flex items-center gap-3">
                            <span className={`w-1 h-10 rounded-r ${ROW_ACCENT[row.status]}`} />
                            {/* Клик по сотруднику — открыть снимок отметки.
                                Кликается вся ячейка с именем, а не только
                                миниатюра: попасть в кружок 40px мышью на
                                ходу неудобно, а искать «где нажать» никто
                                не станет. */}
                            <button
                              onClick={() => setPhotoFor(row)}
                              className="flex items-center gap-3 text-left flex-1 min-w-0 group"
                              title={row.photoThumb ? 'Показать снимок отметки' : 'Снимка нет'}
                            >
                              <SelfieThumb row={row} />
                              <span className="min-w-0">
                                <span className="font-medium block truncate group-hover:underline">
                                  {row.userName || '—'}
                                </span>
                                <span className="text-xs text-muted-foreground">
                                  {row.photoThumb ? 'Есть фото отметки' : 'Без снимка'}
                                </span>
                              </span>
                            </button>
                          </div>
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {row.plannedStart
                            ? <span>{row.plannedStart}–{row.plannedEnd}</span>
                            : <span className="text-muted-foreground">не запланирована</span>}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          {row.clockIn ? (
                            <span>
                              {timeOf(row.clockIn)}
                              <span className="text-muted-foreground"> → {row.clockOut ? timeOf(row.clockOut) : 'на смене'}</span>
                            </span>
                          ) : <span className="text-muted-foreground">—</span>}
                        </td>
                        <td className="px-3 py-2.5 whitespace-nowrap">
                          <span className={`text-xs px-2 py-1 rounded-md font-medium ${STATUS_TONE[row.status]}`}>
                            {STATUS_LABEL[row.status]}
                            {row.status === 'late' && row.lateMinutes > 0 ? ` · ${row.lateMinutes} мин` : ''}
                          </span>
                        </td>
                        <td className="px-3 py-2.5 text-right whitespace-nowrap">
                          <FineCell
                            row={row}
                            canFine={canFine}
                            finesConfigured={report.finesConfigured}
                            busy={finingId === row.userId}
                            onFine={() => void applyFine(row)}
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              <div className="px-3 py-2 border-t bg-muted/20 text-xs text-muted-foreground flex flex-wrap gap-x-4 gap-y-1">
                <span>Опоздание считается от планового начала смены, допуск {report.graceMinutes} мин.</span>
                {report.finesConfigured
                  ? <span>Штраф удерживается только по нажатию — сумма считается по правилам.</span>
                  : <span>Штрафы не настроены — суммы не предлагаются.</span>}
                {report.timezone && <span>Часовой пояс: {report.timezone}</span>}
              </div>
            </div>
          )}
        </>
      )}

      {photoFor && <SelfieDialog row={photoFor} onClose={() => setPhotoFor(null)} />}
    </div>
  )
}

/** Колонка штрафа: сумма к удержанию, уже удержано, или почему кнопки нет. */
function FineCell({
  row, canFine, finesConfigured, busy, onFine,
}: {
  row: RollCallRow
  canFine: boolean
  finesConfigured: boolean
  busy: boolean
  onFine: () => void
}) {
  if (row.status !== 'late') return <span className="text-muted-foreground">—</span>
  if (row.fined) {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <Check className="w-3.5 h-3.5 text-emerald-600 dark:text-emerald-400" /> Удержано
      </span>
    )
  }
  if (!finesConfigured) {
    // Не молчим: без правил кнопки нет, и человек должен понимать почему.
    return <span className="text-xs text-muted-foreground">правила не заданы</span>
  }
  if (!canFine) {
    return <span className="text-xs text-muted-foreground">{formatCurrency(Number(row.suggestedFine ?? 0))}</span>
  }
  return (
    <Button variant="outline" size="sm" disabled={busy} onClick={onFine}>
      {busy
        ? <Loader2 className="w-3.5 h-3.5 animate-spin" />
        : <>Удержать {formatCurrency(Number(row.suggestedFine ?? 0))}</>}
    </Button>
  )
}


function Stat({ label, value, tone, icon }: { label: string; value: number; tone?: string; icon?: React.ReactNode }) {
  return (
    <div className="border rounded-xl px-4 py-3 bg-card">
      <div className="text-xs text-muted-foreground flex items-center gap-1.5">{icon}{label}</div>
      <div className={`text-2xl font-semibold mt-0.5 ${tone ?? ''}`}>{value}</div>
    </div>
  )
}

/**
 * Миниатюра селфи прихода. Превью приходит вместе с перекличкой (~8 КБ), а
 * оригинал тянется только по клику — иначе список на 20 человек весил бы под
 * мегабайт ради картинок, на которые чаще всего не смотрят.
 */
function SelfieThumb({ row }: { row: RollCallRow }) {
  if (!row.photoThumb) {
    return (
      <span className="w-10 h-10 rounded-full bg-muted flex items-center justify-center shrink-0">
        <Camera className="w-4 h-4 text-muted-foreground/60" />
      </span>
    )
  }
  return (
    <span className="w-10 h-10 rounded-full overflow-hidden shrink-0 ring-1 ring-border group-hover:ring-primary transition block">
      <img
        src={`data:image/jpeg;base64,${row.photoThumb}`}
        alt={`Отметка: ${row.userName}`}
        className="w-full h-full object-cover"
      />
    </span>
  )
}

/**
 * Снимок отметки. Оригинал живёт на кассе филиала — если она выключена,
 * показываем превью, которое приехало вместе с перекличкой.
 */
function SelfieDialog({ row, onClose }: { row: RollCallRow; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!row.entryId || !row.photoThumb) return
    let objectUrl: string | null = null
    let alive = true
    void (async () => {
      try {
        const u = await fetchAttendancePhoto(row.entryId!, 'in')
        objectUrl = u
        if (alive) setUrl(u)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Снимок недоступен')
      }
    })()
    // Отзываем object URL: без этого каждый просмотр оставлял бы блоб
    // висеть в памяти вкладки до перезагрузки.
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [row.entryId, row.photoThumb])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {row.userName} · {row.clockIn ? timeOf(row.clockIn) : 'без отметки'}
          </DialogTitle>
        </DialogHeader>

        {!row.photoThumb ? (
          // Частый случай, и он не ошибка: терминала может не быть вовсе, а
          // отметку мог поставить менеджер руками в табеле.
          <div className="text-center py-8 space-y-2">
            <Camera className="w-8 h-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Снимка нет: отметку поставили без терминала (вручную в табеле) либо у терминала не было камеры.
            </p>
          </div>
        ) : error ? (
          <div className="space-y-3">
            <img
              src={`data:image/jpeg;base64,${row.photoThumb}`}
              alt=""
              className="rounded-lg w-full max-w-[240px] mx-auto"
            />
            <p className="text-xs text-muted-foreground text-center">
              {error}. Показано превью — оригинал хранится на кассе, где сделан снимок.
            </p>
          </div>
        ) : url ? (
          <img src={url} alt={`Отметка: ${row.userName}`} className="rounded-lg w-full" />
        ) : (
          <div className="flex justify-center py-10">
            <Loader2 className="w-5 h-5 animate-spin text-muted-foreground" />
          </div>
        )}

        <div className="text-xs text-muted-foreground">
          {row.plannedStart ? `По графику ${row.plannedStart}–${row.plannedEnd}` : 'Смена не запланирована'}
          {row.status === 'late' && row.lateMinutes > 0 ? ` · опоздание ${row.lateMinutes} мин` : ''}
        </div>
      </DialogContent>
    </Dialog>
  )
}
