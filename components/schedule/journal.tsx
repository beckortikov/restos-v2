'use client'

// Фотожурнал: лента приходов и уходов за день со снимками.
//
// Смысл экрана — пролистать смену глазами и увидеть, кто отмечался. Поэтому
// плитки с крупными фото, а не таблица: в таблице снимок превращается в
// иконку, по которой ничего не разобрать, а именно он здесь главное.

import { useCallback, useEffect, useMemo, useState } from 'react'
import { Camera, Loader2 } from 'lucide-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { fetchAttendancePhoto, fetchJournal, type JournalEvent } from '@/lib/queries/schedule'
import { humanizeError } from '@/lib/errors'
import { EmptyHint, addDays, timeOf, ymd } from './shared'

type Filter = 'all' | 'in' | 'out' | 'nophoto'

const FILTERS: Array<{ key: Filter; label: string }> = [
  { key: 'all', label: 'Все' },
  { key: 'in', label: 'Приходы' },
  { key: 'out', label: 'Уходы' },
  { key: 'nophoto', label: 'Без фото' },
]

export function JournalView({ date, onDate }: { date: string; onDate: (d: string) => void }) {
  const [rows, setRows] = useState<JournalEvent[]>([])
  const [loading, setLoading] = useState(true)
  const [filter, setFilter] = useState<Filter>('all')
  const [photoFor, setPhotoFor] = useState<JournalEvent | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    try {
      setRows(await fetchJournal(date))
    } catch (e) {
      toast.error(humanizeError(e))
    } finally {
      setLoading(false)
    }
  }, [date])

  useEffect(() => { void load() }, [load])

  const shown = useMemo(() => rows.filter((r) => {
    if (filter === 'in') return r.kind === 'in'
    if (filter === 'out') return r.kind === 'out'
    if (filter === 'nophoto') return !r.photoThumb
    return true
  }), [rows, filter])

  // Счётчики на самих фильтрах: «Без фото — 3» это и есть то, ради чего
  // экран открывают, и прятать это число за нажатием незачем.
  const counts = useMemo(() => ({
    all: rows.length,
    in: rows.filter((r) => r.kind === 'in').length,
    out: rows.filter((r) => r.kind === 'out').length,
    nophoto: rows.filter((r) => !r.photoThumb).length,
  }), [rows])

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center gap-2">
        <Button variant="outline" size="sm" onClick={() => onDate(addDays(date, -1))} aria-label="Предыдущий день">←</Button>
        <Input type="date" value={date} onChange={(e) => onDate(e.target.value)} className="w-44" />
        <Button variant="outline" size="sm" onClick={() => onDate(addDays(date, 1))} aria-label="Следующий день">→</Button>
        <Button variant="outline" size="sm" onClick={() => onDate(ymd(new Date()))}>Сегодня</Button>

        <div className="flex-1" />

        <div className="flex gap-1 bg-muted/30 p-0.5 rounded-lg">
          {FILTERS.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setFilter(key)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                filter === key ? 'bg-card shadow-sm text-foreground' : 'text-muted-foreground'
              }`}
            >
              {label}
              <span className="ml-1.5 opacity-60">{counts[key]}</span>
            </button>
          ))}
        </div>
      </div>

      {loading ? (
        <div className="flex items-center gap-2 text-sm text-muted-foreground py-10 justify-center">
          <Loader2 className="w-4 h-4 animate-spin" /> Загружаем ленту…
        </div>
      ) : shown.length === 0 ? (
        <EmptyHint text={rows.length === 0 ? 'В этот день отметок не было.' : 'Под фильтр ничего не попало.'} />
      ) : (
        <div className="grid gap-3 grid-cols-2 md:grid-cols-3 xl:grid-cols-4">
          {shown.map((row) => (
            <JournalCard key={`${row.entryId}-${row.kind}`} row={row} onOpen={() => setPhotoFor(row)} />
          ))}
        </div>
      )}

      {photoFor && <JournalPhotoDialog row={photoFor} onClose={() => setPhotoFor(null)} />}
    </div>
  )
}

function JournalCard({ row, onOpen }: { row: JournalEvent; onOpen: () => void }) {
  const isIn = row.kind === 'in'
  return (
    <button
      onClick={onOpen}
      className="border rounded-xl overflow-hidden bg-card text-left hover:shadow-sm transition-shadow"
    >
      <div className="relative h-44 bg-muted">
        {row.photoThumb ? (
          <img
            src={`data:image/jpeg;base64,${row.photoThumb}`}
            alt={`${row.userName}, ${timeOf(row.at)}`}
            className="w-full h-full object-cover"
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1.5 text-muted-foreground/60">
            <Camera className="w-6 h-6" />
            <span className="text-xs">без фото</span>
          </div>
        )}

        <span
          className={`absolute top-2 left-2 text-[11px] font-semibold px-2 py-1 rounded-md ${
            isIn
              ? 'bg-emerald-600/90 text-white'
              : 'bg-amber-600/90 text-white'
          }`}
        >
          {isIn ? 'Приход' : 'Уход'}
        </span>

        {row.lateMinutes > 0 && (
          <span className="absolute top-2 right-2 text-[11px] font-semibold px-2 py-1 rounded-md bg-red-600/90 text-white">
            +{row.lateMinutes} мин
          </span>
        )}
      </div>

      <div className="px-3 py-2.5">
        <div className="font-medium truncate">{row.userName || '—'}</div>
        <div className="text-xs text-muted-foreground">
          {timeOf(row.at)}
          {/* Ручную отметку показываем явно: у неё не бывает снимка, и это
              не повод считать её подозрительной. */}
          {row.source === 'manual' && ' · внесено вручную'}
        </div>
      </div>
    </button>
  )
}

function JournalPhotoDialog({ row, onClose }: { row: JournalEvent; onClose: () => void }) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (!row.photoThumb) return
    let objectUrl: string | null = null
    let alive = true
    void (async () => {
      try {
        const u = await fetchAttendancePhoto(row.entryId, row.kind)
        objectUrl = u
        if (alive) setUrl(u)
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : 'Снимок недоступен')
      }
    })()
    return () => { alive = false; if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [row.entryId, row.kind, row.photoThumb])

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onClose() }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {row.userName} · {row.kind === 'in' ? 'приход' : 'уход'} {timeOf(row.at)}
          </DialogTitle>
        </DialogHeader>

        {!row.photoThumb ? (
          <div className="text-center py-8 space-y-2">
            <Camera className="w-8 h-8 mx-auto text-muted-foreground/50" />
            <p className="text-sm text-muted-foreground">
              Снимка нет: отметку поставили без терминала либо у него не было камеры.
            </p>
          </div>
        ) : error ? (
          <div className="space-y-3">
            <img src={`data:image/jpeg;base64,${row.photoThumb}`} alt="" className="rounded-lg w-full max-w-[240px] mx-auto" />
            <p className="text-xs text-muted-foreground text-center">
              {error}. Показано превью — оригинал хранится на кассе, где сделан снимок.
            </p>
          </div>
        ) : url ? (
          <img src={url} alt={`Отметка: ${row.userName}`} className="rounded-lg w-full" />
        ) : (
          <div className="flex justify-center py-10"><Loader2 className="w-5 h-5 animate-spin text-muted-foreground" /></div>
        )}

        {row.lateMinutes > 0 && (
          <div className="text-xs text-amber-700 dark:text-amber-400">Опоздание {row.lateMinutes} мин</div>
        )}
      </DialogContent>
    </Dialog>
  )
}
