'use client'

/**
 * OrderCancelForm — inline-форма «Отменить весь заказ» с выбором причины.
 * Извлечена из OrderActionsBody. Сам вызов cancelOrder делает родитель — мы
 * только собираем UI-state.
 */

import { useState } from 'react'
import { toast } from 'sonner'
import { Ban } from 'lucide-react'
import { cancelOrder } from '@/lib/queries'

const CANCEL_QUICK_REASONS = [
  { label: 'Клиент отменил', value: 'Отменено клиентом' },
  { label: 'Кухня отменила', value: 'Отменено кухней' },
] as const

const CANCEL_REASON_PRESETS = [
  'Ошибка официанта',
  'Нет ингредиента',
  'Другое',
]

interface OrderCancelFormProps {
  orderId: string
  userId?: string
  onCancelled: () => void
}

export function OrderCancelForm({ orderId, userId, onCancelled }: OrderCancelFormProps) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [reasonChoice, setReasonChoice] = useState<string>('Ошибка официанта')
  const [reasonCustom, setReasonCustom] = useState('')
  const [more, setMore] = useState(false)
  const [inFlight, setInFlight] = useState(false)

  const submit = async (reason: string) => {
    if (!reason) return
    setInFlight(true)
    try {
      await cancelOrder(orderId, reason, userId)
      toast.success('Заказ отменён')
      setConfirmOpen(false)
      setMore(false)
      onCancelled()
    } catch (e: any) {
      toast.error(e?.message ?? 'Ошибка отмены')
    } finally {
      setInFlight(false)
    }
  }

  if (!confirmOpen) {
    return (
      <button
        onClick={() => setConfirmOpen(true)}
        className="w-full inline-flex items-center justify-center gap-1.5 rounded-xl border-2 border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 hover:bg-zinc-50 transition-colors"
      >
        <Ban className="size-4" />
        Отменить весь заказ
      </button>
    )
  }

  return (
    <div className="rounded-xl border-2 border-zinc-300 bg-zinc-50 p-3 space-y-2">
      <div className="text-xs font-semibold text-zinc-700">Отменить весь заказ?</div>
      <div className="grid grid-cols-2 gap-1.5">
        {CANCEL_QUICK_REASONS.map((q) => (
          <button
            key={q.value}
            disabled={inFlight}
            onClick={() => submit(q.value)}
            className="text-xs font-medium px-2 py-2 rounded-md bg-zinc-700 text-white hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            {q.label}
          </button>
        ))}
      </div>
      {!more ? (
        <button
          onClick={() => setMore(true)}
          className="w-full text-[11px] text-zinc-500 hover:text-zinc-700 underline transition-colors"
        >
          Другая причина…
        </button>
      ) : (
        <>
          <div className="grid grid-cols-2 gap-1.5">
            {CANCEL_REASON_PRESETS.map((r) => (
              <button
                key={r}
                onClick={() => setReasonChoice(r)}
                className={`text-xs px-2 py-1.5 rounded-md border transition-colors ${
                  reasonChoice === r
                    ? 'border-primary bg-primary/5 text-primary'
                    : 'border-zinc-200 bg-white text-zinc-600 hover:border-zinc-300'
                }`}
              >
                {r}
              </button>
            ))}
          </div>
          {reasonChoice === 'Другое' && (
            <input
              type="text"
              placeholder="Опишите причину"
              value={reasonCustom}
              onChange={e => setReasonCustom(e.target.value)}
              className="w-full text-xs rounded-md border border-zinc-200 bg-white px-2 py-1.5 focus:outline-none focus:ring-1 focus:ring-primary/30"
            />
          )}
          <button
            disabled={inFlight || (reasonChoice === 'Другое' && !reasonCustom.trim())}
            onClick={() => submit(reasonChoice === 'Другое' ? reasonCustom.trim() : reasonChoice)}
            className="w-full text-xs font-medium bg-zinc-700 text-white rounded-md py-1.5 hover:bg-zinc-800 transition-colors disabled:opacity-50"
          >
            Подтвердить отмену заказа
          </button>
        </>
      )}
      <button
        onClick={() => { setConfirmOpen(false); setMore(false) }}
        className="w-full text-[11px] text-zinc-500 hover:text-zinc-700 transition-colors"
      >
        Закрыть
      </button>
    </div>
  )
}
