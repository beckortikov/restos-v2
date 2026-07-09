'use client'

import { type ReactNode, useEffect, useRef } from 'react'
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
  const cardRef = useRef<HTMLDivElement>(null)
  // Фокус в карточку — ТОЛЬКО при открытии модалки. Раньше это стояло в одном
  // эффекте с Esc-listener'ом (deps [open, dismissable, onClose]); onClose
  // почти всегда инлайн-стрелка (новая ссылка на каждый рендер) → эффект
  // перезапускался на КАЖДЫЙ ре-рендер и cardRef.focus() КРАЛ фокус у инпута.
  // При вводе символа родитель ре-рендерился → фокус улетал в карточку →
  // экранная клавиатура закрывалась после первой же цифры. Теперь фокус — раз.
  useEffect(() => {
    if (!open) return
    // НЕ воруем фокус, если внутри уже сфокусирован автофокус-инпут (сумма,
    // комментарий) — иначе экранная клавиатура не подхватила бы поле. Фокус в
    // карточку ставим только когда фокуса внутри неё ещё нет (a11y).
    const card = cardRef.current
    if (card && !card.contains(document.activeElement)) card.focus()
  }, [open])
  // Esc закрывает модалку (WCAG 2.1.2 — не ловушка клавиатуры) — отдельный
  // эффект, его перезапуск на смену onClose безвреден (только listener).
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && dismissable) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, dismissable, onClose])

  if (!open) return null
  return (
    <div
      className="fixed inset-0 z-50"
      style={{ background: 'rgba(26,26,26,0.5)' }}
      onClick={() => { if (dismissable) onClose() }}
    >
      <div
        ref={cardRef}
        role="dialog"
        aria-modal="true"
        aria-label={typeof title === 'string' ? title : 'Диалог'}
        tabIndex={-1}
        className="rounded-3xl flex flex-col"
        style={{
          position: 'fixed', left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
          background: 'var(--pv-card)', width, maxHeight: '86vh', overflow: 'hidden',
          boxShadow: '0 20px 60px rgba(0,0,0,0.3)', outline: 'none',
        }}
        onClick={e => e.stopPropagation()}
      >
        {title !== undefined && (
          <div
            className="flex items-center justify-between border-b shrink-0"
            style={{ padding: 'clamp(1rem,1.6vw,1.4rem)', borderColor: 'var(--pv-border)' }}
          >
            <span className="font-bold truncate" style={{ fontSize: 'clamp(1.05rem,1.5vw,1.35rem)', color: 'var(--pv-text)' }}>{title}</span>
            <button onClick={() => onClose()} aria-label="Закрыть" className="rounded-lg shrink-0 flex items-center justify-center" style={{ padding: '0.4rem' }}><X style={{ color: 'var(--pv-text-2)' }} /></button>
          </div>
        )}
        <div className="overflow-y-auto" style={{ minHeight: 0 }}>{children}</div>
      </div>
    </div>
  )
}
