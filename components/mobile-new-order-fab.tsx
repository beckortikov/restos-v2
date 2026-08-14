'use client'

import { lazy, Suspense, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { Plus } from 'lucide-react'

// Диалог тянет за собой OrderComposer (168 КБ). FAB висит в AppLayout на всех
// экранах, поэтому статический импорт затаскивал композер в стартовый бандл —
// его парсили даже на PIN-экране. Грузим только когда кассир реально нажал «+».
const CreateOrderDialog = lazy(() =>
  import('@/components/dialogs/create-order-dialog').then((m) => ({ default: m.CreateOrderDialog })),
)

const VISIBLE_ROUTES = [
  '/operations/table-map',
  '/operations/orders',
  '/operations/pos',
]

export function MobileNewOrderFab() {
  const { pathname } = useLocation()
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)

  const visible = VISIBLE_ROUTES.some(
    (r) => pathname === r || pathname.startsWith(r + '/')
  )
  if (!visible) return null

  return (
    <>
      <button
        onClick={() => setOpen(true)}
        className="sm:hidden fixed bottom-20 right-5 z-40 size-14 flex items-center justify-center bg-primary text-primary-foreground rounded-full shadow-lg hover:bg-primary/90 active:scale-95 transition-all"
        aria-label="Новый заказ"
      >
        <Plus className="size-7" strokeWidth={2.5} />
      </button>

      {open && (
        <Suspense fallback={null}>
          <CreateOrderDialog
            open={open}
            onOpenChange={setOpen}
            onSubmitted={() => {
              setOpen(false)
              if (pathname !== '/operations/orders') {
                navigate('/operations/orders')
              }
            }}
          />
        </Suspense>
      )}
    </>
  )
}
