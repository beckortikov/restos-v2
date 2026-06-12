'use client'

import { useEffect, useMemo, useRef } from 'react'
import { useNavigate, useSearchParams } from 'react-router-dom'
import { OrderComposer } from '@/components/order/order-composer'
import { useAuth } from '@/lib/auth-store'
import { getDraft, saveDraft, deleteDraft, listDrafts } from '@/lib/waiter/drafts'
import { toast } from 'sonner'

const SAVE_DEBOUNCE_MS = 300

export default function WaiterNewOrderPage() {
  const [params] = useSearchParams()
  const navigate = useNavigate()
  const { user } = useAuth()

  const addTo = params.get('addTo') || undefined
  const table = params.get('table') || undefined
  const newGroup = params.get('newGroup') === '1'
  const resume = params.get('resume') === '1'

  // Resume from draft (only when explicitly asked).
  const initial = useMemo(() => {
    if (!resume || !table) return null
    return getDraft(table)
  }, [resume, table])

  // Enforce flow: zal-заказы создаём ТОЛЬКО из контекста стола. Если на
  // /waiter/order/new пришли без ?table=, без ?addTo=, без ?resume= и нет
  // сохранённого draft с прошлого набора — редиректим на список столов.
  // Закрывает: cold-start Capacitor с устаревшим URL + случайные «Новый
  // заказ» FAB-ы которые обходят выбор стола.
  useEffect(() => {
    if (table || addTo || resume) return
    if (!user) return
    const drafts = listDrafts(user.id)
    if (drafts.length > 0) return
    toast.message('Сначала выберите стол')
    navigate('/waiter/tables?selectFor=new', { replace: true })
  }, [table, addTo, resume, user, navigate])

  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Last known cart state — used to flush a save on unmount so a draft is
  // never lost when the waiter taps «Назад» within the debounce window.
  const lastStateRef = useRef<{ cart: import('@/components/order/types').CartLine[]; tableId: string; guestsCount: number; tabLabel: string } | null>(null)

  const flushSave = () => {
    const state = lastStateRef.current
    if (!user || !state) return
    if (!state.tableId || state.cart.length === 0) {
      deleteDraft(state.tableId || initial?.tableId || '')
      return
    }
    saveDraft({
      tableId: state.tableId,
      tabLabel: state.tabLabel || undefined,
      guestsCount: state.guestsCount,
      lines: state.cart,
      waiterId: user.id,
    })
  }

  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current)
      // Synchronous flush: without this, a quick «back» press loses the draft.
      flushSave()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function handleCartChange(state: { cart: import('@/components/order/types').CartLine[]; tableId: string; guestsCount: number; tabLabel: string }) {
    if (!user) return
    lastStateRef.current = state
    if (saveTimer.current) clearTimeout(saveTimer.current)
    saveTimer.current = setTimeout(() => {
      flushSave()
    }, SAVE_DEBOUNCE_MS)
  }

  return (
    <div className="flex flex-col h-full safe-area-top">
      {addTo ? (
        <OrderComposer
          mode="add"
          orderId={addTo}
          compactMode
          onSubmitted={(arg) => navigate(`/waiter/order/${arg?.orderId ?? addTo}`)}
          onCancel={() => navigate(-1)}
        />
      ) : (
        <OrderComposer
          mode="new"
          compactMode
          initialOrderType="hall"
          initialTableId={table ?? initial?.tableId}
          initialCart={initial?.lines}
          initialGuests={initial?.guestsCount}
          initialTabLabel={initial?.tabLabel}
          lockDestination={!!table}
          forceNewOrder={newGroup}
          onCartChange={handleCartChange}
          onSubmitted={(arg) => {
            const used = table ?? initial?.tableId
            if (used) deleteDraft(used)
            // Сразу на детали заказа — официант видит созданный заказ
            // и может проверить позиции / распечатать чек.
            if (arg?.orderId) {
              navigate(`/waiter/order/${arg.orderId}`)
            } else {
              navigate('/waiter/tables')
            }
          }}
          onCancel={() => navigate(-1)}
        />
      )}
    </div>
  )
}
