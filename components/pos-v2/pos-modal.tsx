'use client'

import { type ReactNode } from 'react'
import { X } from 'lucide-react'

// Единый модальный компонент /pos2. Ключевое отличие от прежних самодельных
// `fixed inset-0 flex`-оверлеев: карточка имеет role="dialog" и позиционируется
// как Radix (position:fixed; top/left:50%; translate). Благодаря computed
// top !== 'auto' экранная клавиатура (on-screen-keyboard applyLift) поднимает
// САМУ модалку через margin-top, а не скроллит фон под оверлеем (это и был
// «прыжок экрана» при фокусе на инпуте, напр. в расходе смены).
//
// Тело — отдельный overflow-y-auto контейнер: клавиатура/длинный контент
// скроллятся внутри модалки, страница за ней стоит на месте.
export function PosModal({
  open,
  onClose,
  title,
  children,
  width = 'clamp(22rem,44vw,34rem)',
  dismissable = true,
}: {
  open: boolean
  onClose: () => void
  title?: ReactNode
  children: ReactNode
  width?: string
  dismissable?: boolean
}) {
  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50"
      style={{ background: 'rgba(26,26,26,0.5)' }}
      onClick={() => { if (dismissable) onClose() }}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="rounded-3xl flex flex-col"
        style={{
          position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
          background: 'var(--pv-card)', width, maxHeight: '86vh', overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)',
        }}
        onClick={e => e.stopPropagation()}
      >
        {title !== undefined && (
          <div
            className="flex items-center justify-between border-b shrink-0"
            style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}
          >
            <span className="font-bold truncate" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', color: 'var(--pv-text)' }}>{title}</span>
            <button onClick={() => onClose()} className="rounded-lg shrink-0" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
          </div>
        )}
        <div className="overflow-y-auto" style={{ minHeight: 0 }}>{children}</div>
      </div>
    </div>
  )
}
