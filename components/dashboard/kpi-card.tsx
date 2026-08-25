'use client'

import { Link } from 'react-router-dom'

// Общие карточки дашборда (KPI-плитка + строка алерта «Требует внимания») —
// вынесены из app/(app)/dashboard/page.tsx, чтобы сетевой дашборд central
// (network-view.tsx) переиспользовал ровно тот же визуальный язык без
// циклического импорта между page.tsx и network-view.tsx.

export function KpiCard({
  label, value, sub, icon: Icon, color = 'primary', href,
}: {
  label: string; value: string; sub?: string
  icon: React.ElementType; color?: string; href?: string
}) {
  // ВАЖНО: используем react-router-dom <Link>, а не <a href>. В Electron
  // file:// нативный <a> уходит в browser navigation (file:///finance/...)
  // и показывает белый экран. Link делает SPA-навигацию через HashRouter.
  const cls = `bg-card rounded-xl border border-border p-4 md:p-5 ${href ? 'hover:border-primary/40 transition-colors cursor-pointer block' : ''}`
  const inner = (
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <p className="text-muted-foreground text-[11px] font-medium uppercase tracking-wide truncate">{label}</p>
        <p className="text-xl md:text-2xl font-bold text-foreground mt-1 leading-none">{value}</p>
        {sub && <p className="text-muted-foreground text-[11px] mt-1.5 truncate">{sub}</p>}
      </div>
      <div className={`size-9 md:size-10 rounded-lg flex items-center justify-center shrink-0 ${color}`}>
        <Icon className="size-4 md:size-5" />
      </div>
    </div>
  )
  return href ? <Link to={href} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>
}

export function AlertItem({
  icon: Icon, text, severity = 'warn', href,
}: {
  icon: React.ElementType; text: string; severity?: 'warn' | 'error' | 'info'; href?: string
}) {
  const colors = {
    warn: 'text-amber-600 bg-amber-50 border-amber-200',
    error: 'text-red-600 bg-red-50 border-red-200',
    info: 'text-blue-600 bg-blue-50 border-blue-200',
  }
  const cls = `flex items-center gap-2.5 px-3 py-2.5 rounded-lg border text-sm ${colors[severity]} ${href ? 'hover:opacity-80 transition-opacity' : ''}`
  const inner = (<>
    <Icon className="size-4 shrink-0" />
    <span className="truncate">{text}</span>
  </>)
  return href ? <Link to={href} className={cls}>{inner}</Link> : <div className={cls}>{inner}</div>
}
