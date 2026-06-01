'use client'

// Главная страница «Заказы». Содержит два таба: Активные (заказы текущей
// смены) и История (closed/cancelled за период). Раньше всё было на одной
// странице — фильтр «сегодня» жёстко вшит в loader, а отмен/закрытий было
// не отделить. Теперь два таба внутри одного URL.

import { useSearchParams } from 'react-router-dom'
import { ActiveOrdersTab } from '@/components/orders/active-orders-tab'
import { HistoryOrdersTab } from '@/components/orders/history-orders-tab'

type Tab = 'active' | 'history'

export default function OrdersPage() {
  const [searchParams, setSearchParams] = useSearchParams()
  const tabParam = searchParams.get('tab')
  const tab: Tab = tabParam === 'history' ? 'history' : 'active'

  const setTab = (next: Tab) => {
    const sp = new URLSearchParams(searchParams)
    if (next === 'active') sp.delete('tab')
    else sp.set('tab', next)
    setSearchParams(sp, { replace: true })
  }

  return (
    <div className="p-4 md:p-6 space-y-4 md:space-y-5">
      <div className="sticky top-0 z-20 -mx-4 -mt-4 px-4 pt-4 pb-2 md:-mx-6 md:-mt-6 md:px-6 md:pt-6 bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80 border-b border-border">
        <div className="flex items-end justify-between gap-3">
          <div>
            <h1 className="text-xl font-bold text-foreground">Заказы</h1>
            <p className="text-muted-foreground text-sm mt-0.5">
              {tab === 'active' ? 'Активные заказы текущей смены' : 'История заказов за период'}
            </p>
          </div>
        </div>
        <div className="mt-3 flex items-center gap-1 border-b border-border -mb-px">
          <TabButton active={tab === 'active'} onClick={() => setTab('active')}>Активные</TabButton>
          <TabButton active={tab === 'history'} onClick={() => setTab('history')}>История</TabButton>
        </div>
      </div>

      {tab === 'active' ? <ActiveOrdersTab /> : <HistoryOrdersTab />}
    </div>
  )
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: React.ReactNode }) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-2 text-sm font-medium border-b-2 transition-colors ${
        active
          ? 'border-primary text-foreground'
          : 'border-transparent text-muted-foreground hover:text-foreground'
      }`}
    >
      {children}
    </button>
  )
}
