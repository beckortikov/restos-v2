'use client'

// confirmDialog — императивная замена window.confirm() поверх РЕАЛЬНОГО
// Radix AlertDialog (components/ui/alert-dialog.tsx), не самодельного div'а.
//
// Зачем НЕ нативный confirm(): в Electron после закрытия alert()/confirm()
// инпуты страницы перестают принимать фокус и ввод, пока окно не потеряет и
// не вернёт фокус (многолетний баг Chromium-эмбеддера: electron/electron
// #19977, #20821, #31917, #35872, #40212, #41602). На кассе в fullscreen-киоске
// «сблуррить и вернуть» окно нечем — после подтверждения удаления экранная
// клавиатура (живёт только на focusin) молча переставала открываться.
//
// Зачем именно Radix AlertDialog, а не свой div+createRoot с overlay/фокусом
// с нуля: этот диалог может открываться ПОВЕРХ уже открытого Radix Dialog/Sheet
// (BottomSheet в order-actions-body.tsx — «Открыть заказ для редактирования?»
// вызывается изнутри уже открытого Sheet). У Radix стек dismissable-layer'ов
// и focus-scope — модульный синглтон (не React-контекст), поэтому НОВЫЙ
// Radix-примитив, смонтированный отдельным createRoot, корректно встаёт
// поверх уже открытого как топ стека: сам получает фокус-трап, сам глушит
// нативный outside-pointerdown, сам не даёт внешнему слою увидеть «клик
// снаружи». Самодельный div этого не умеет из коробки — раньше здесь была
// такая попытка и она ломалась именно на этом стыке (нет pointer-events-auto
// поверх body с pointer-events:none от внешнего Dialog, нативный pointerdown
// снаружи не глушится React-onClick, автофокус кнопки перетягивался обратно
// в FocusScope внешнего Sheet).
//
// Использование (везде, где раньше был window.confirm):
//   if (!(await confirmDialog({ title: 'Удалить расход?', message: '…', danger: true }))) return

import { createRoot } from 'react-dom/client'
import { useRef, useState } from 'react'
import {
  AlertDialog, AlertDialogContent, AlertDialogHeader, AlertDialogTitle,
  AlertDialogDescription, AlertDialogFooter, AlertDialogAction, AlertDialogCancel,
} from '@/components/ui/alert-dialog'
import { buttonVariants } from '@/components/ui/button'

export interface ConfirmOptions {
  /** Короткий вопрос в заголовке («Удалить расход?»). */
  title?: string
  /** Пояснение под заголовком. \n переносит строку. */
  message: string
  /** Подпись кнопки подтверждения. По умолчанию «Подтвердить». */
  confirmLabel?: string
  /** Подпись кнопки отмены. По умолчанию «Отмена». */
  cancelLabel?: string
  /**
   * Необратимое/деструктивное действие: кнопка подтверждения красная, и —
   * важно для физической клавиатуры на «Смене» — автофокус по умолчанию
   * НЕ на неё, а на «Отмена» (тач-панель Enter'ом не пользуется, но кассир
   * на «Смене» может дойти сюда с клавиатуры и таб-переходом).
   */
  danger?: boolean
}

function ConfirmRoot({ opts, onDone }: { opts: ConfirmOptions; onDone: (ok: boolean) => void }) {
  const [open, setOpen] = useState(true)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const actionRef = useRef<HTMLButtonElement>(null)
  const close = (ok: boolean) => { setOpen(false); onDone(ok) }

  return (
    <AlertDialog
      open={open}
      onOpenChange={(o) => { if (!o) close(false) }} // Esc/программное закрытие ­— как «Отмена»
    >
      <AlertDialogContent
        className="sm:max-w-md"
        onOpenAutoFocus={(e) => {
          // Radix по умолчанию фокусит первый focusable — переопределяем: для
          // danger безопаснее «Отмена», иначе Enter/повторный тап-в-то-же-место
          // сразу подтверждает необратимое действие.
          e.preventDefault()
          ;(opts.danger ? cancelRef : actionRef).current?.focus()
        }}
      >
        <AlertDialogHeader>
          {opts.title && <AlertDialogTitle>{opts.title}</AlertDialogTitle>}
          <AlertDialogDescription className="whitespace-pre-line">
            {opts.message}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel ref={cancelRef} onClick={() => close(false)}>
            {opts.cancelLabel ?? 'Отмена'}
          </AlertDialogCancel>
          <AlertDialogAction
            ref={actionRef}
            onClick={() => close(true)}
            className={opts.danger ? buttonVariants({ variant: 'destructive' }) : undefined}
          >
            {opts.confirmLabel ?? 'Подтвердить'}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}

/**
 * Показать диалог подтверждения. Резолвится true при подтверждении,
 * false при отмене (кнопка «Отмена», Esc).
 */
export function confirmDialog(opts: ConfirmOptions | string): Promise<boolean> {
  const options: ConfirmOptions = typeof opts === 'string' ? { message: opts } : opts
  if (typeof document === 'undefined') return Promise.resolve(false)
  return new Promise((resolve) => {
    const host = document.createElement('div')
    document.body.appendChild(host)
    const root = createRoot(host)
    let settled = false
    const done = (ok: boolean) => {
      if (settled) return
      settled = true
      resolve(ok)
      // Даём доиграть exit-анимацию AlertDialogContent/Overlay (data-state=
      // closed, duration-200) перед размонтированием — раньше здесь unmount
      // был мгновенным, и «Отмена»/Esc обрубали fade/zoom-out на середине.
      window.setTimeout(() => { root.unmount(); host.remove() }, 220)
    }
    root.render(<ConfirmRoot opts={options} onDone={done} />)
  })
}
