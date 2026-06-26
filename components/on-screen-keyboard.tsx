'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Delete, ArrowBigUp, X, CornerDownLeft, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'

// ─────────────────────────────────────────────────────────────────────────────
// PosKeyboard — экранная клавиатура для POS (в стиле iiko: крупные кнопки,
// под дизайн restos). Появляется при фокусе на любом текстовом/числовом инпуте
// внутри POS. Монтируется один раз на странице POS — пока компонент жив,
// слушатель focusin/focusout активен только в POS.
//
// Как печатает в controlled-инпуты React: через нативный value-сеттер +
// dispatch('input') — React ловит событие и обновляет state.
//
// Фокус инпута не теряется при нажатии клавиш: onMouseDown preventDefault на
// каждой кнопке. Нативный stopPropagation на pointerdown корня не даёт
// Radix-диалогам закрыться по «клику снаружи».
// ─────────────────────────────────────────────────────────────────────────────

type Layout = 'text' | 'numeric'
type Lang = 'ru' | 'en'

const RU_ROWS: string[][] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х'],
  ['ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
  ['я', 'ч', 'с', 'м', 'и', 'т', 'ь', 'б', 'ю'],
]

const EN_ROWS: string[][] = [
  ['1', '2', '3', '4', '5', '6', '7', '8', '9', '0'],
  ['q', 'w', 'e', 'r', 't', 'y', 'u', 'i', 'o', 'p'],
  ['a', 's', 'd', 'f', 'g', 'h', 'j', 'k', 'l'],
  ['z', 'x', 'c', 'v', 'b', 'n', 'm'],
]

const TYPEABLE_INPUT_TYPES = new Set([
  '', 'text', 'search', 'number', 'tel', 'password', 'email', 'url',
])

function isTypeable(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el) return false
  const node = el as HTMLInputElement | HTMLTextAreaElement
  if (node.readOnly || node.disabled) return false
  if (node.closest('[data-no-vk]')) return false
  if (el.tagName === 'TEXTAREA') return true
  if (el.tagName !== 'INPUT') return false
  const type = (el.getAttribute('type') || '').toLowerCase()
  return TYPEABLE_INPUT_TYPES.has(type)
}

function layoutFor(el: HTMLInputElement | HTMLTextAreaElement): Layout {
  const type = (el.getAttribute('type') || '').toLowerCase()
  const im = (el.getAttribute('inputmode') || '').toLowerCase()
  if (type === 'number' || type === 'tel') return 'numeric'
  if (im === 'numeric' || im === 'decimal' || im === 'tel') return 'numeric'
  return 'text'
}

// Пишем значение так, чтобы React (controlled inputs) увидел изменение.
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  desc?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

export function OnScreenKeyboard() {
  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<Layout>('text')
  const [lang, setLang] = useState<Lang>('ru')
  const [shift, setShift] = useState(false)

  const activeRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)

  // ── focus tracking (POS-scoped: слушатели живут пока компонент смонтирован) ──
  useEffect(() => {
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as Element | null
      if (!isTypeable(el)) return
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      activeRef.current = el
      setLayout(layoutFor(el))
      setShift(false)
      setOpen(true)
      // Подскроллим инпут в зону видимости над клавиатурой.
      window.setTimeout(() => el.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 60)
    }
    const onFocusOut = () => {
      // Закрываем, только если фокус ушёл не на другой инпут (с задержкой —
      // дать focusin перехватить переключение между полями).
      closeTimer.current = window.setTimeout(() => {
        if (!isTypeable(document.activeElement)) {
          setOpen(false)
          activeRef.current = null
        }
      }, 150)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
    }
  }, [])

  // Не даём pointerdown по клавиатуре всплыть до document — иначе Radix-диалоги
  // закрылись бы по «клику снаружи».
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const stop = (e: Event) => e.stopPropagation()
    root.addEventListener('pointerdown', stop)
    root.addEventListener('mousedown', stop)
    return () => {
      root.removeEventListener('pointerdown', stop)
      root.removeEventListener('mousedown', stop)
    }
  }, [open])

  const applyChar = useCallback((ch: string) => {
    const el = activeRef.current
    if (!el) return
    setNativeValue(el, el.value + ch)
    el.focus()
  }, [])

  const applyBackspace = useCallback(() => {
    const el = activeRef.current
    if (!el) return
    setNativeValue(el, el.value.slice(0, -1))
    el.focus()
  }, [])

  const applyClear = useCallback(() => {
    const el = activeRef.current
    if (!el) return
    setNativeValue(el, '')
    el.focus()
  }, [])

  const applyDone = useCallback(() => {
    const el = activeRef.current
    el?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }))
    el?.blur()
    activeRef.current = null
    setOpen(false)
  }, [])

  const handleLetter = useCallback((ch: string) => {
    applyChar(shift ? ch.toUpperCase() : ch)
    if (shift) setShift(false) // авто-сброс Shift после буквы (как на телефоне)
  }, [applyChar, shift])

  const rows = useMemo(() => (lang === 'ru' ? RU_ROWS : EN_ROWS), [lang])

  if (!open) return null

  return (
    <div
      ref={rootRef}
      data-no-vk
      className={cn(
        'fixed inset-x-0 bottom-0 z-[90] select-none',
        'bg-card/95 backdrop-blur-md border-t border-border shadow-2xl',
        'rounded-t-2xl px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))]',
        'animate-in slide-in-from-bottom-4 duration-150',
      )}
    >
      <div className="mx-auto w-full max-w-3xl">
        {/* Хедер: ручка + закрыть */}
        <div className="flex items-center justify-between px-1 pb-1.5">
          <div className="mx-auto h-1 w-10 rounded-full bg-muted-foreground/30" />
          <button
            type="button"
            aria-label="Скрыть клавиатуру"
            onMouseDown={(e) => e.preventDefault()}
            onClick={applyDone}
            className="absolute right-3 top-2 grid size-8 place-items-center rounded-lg bg-muted text-muted-foreground hover:bg-muted/70 active:scale-95"
          >
            <X className="size-4" />
          </button>
        </div>

        {layout === 'numeric' ? (
          <NumericPad
            onChar={applyChar}
            onBackspace={applyBackspace}
            onClear={applyClear}
            onDone={applyDone}
          />
        ) : (
          <TextPad
            rows={rows}
            shift={shift}
            lang={lang}
            onLetter={handleLetter}
            onChar={applyChar}
            onBackspace={applyBackspace}
            onShift={() => setShift((s) => !s)}
            onLang={() => setLang((l) => (l === 'ru' ? 'en' : 'ru'))}
            onDone={applyDone}
          />
        )}
      </div>
    </div>
  )
}

// ── Базовая клавиша ─────────────────────────────────────────────────────────
function Key({
  children,
  onTap,
  className,
  variant = 'default',
}: {
  children: ReactNode
  onTap: () => void
  className?: string
  variant?: 'default' | 'muted' | 'primary'
}) {
  return (
    <button
      type="button"
      // preventDefault на mousedown — не даём кнопке украсть фокус у инпута.
      onMouseDown={(e) => e.preventDefault()}
      onClick={onTap}
      className={cn(
        'flex h-12 flex-1 items-center justify-center rounded-xl text-lg font-medium',
        'border transition-transform active:scale-95 sm:h-14 sm:text-xl',
        variant === 'default' && 'border-border bg-background hover:bg-muted',
        variant === 'muted' && 'border-border bg-muted text-muted-foreground hover:bg-muted/70',
        variant === 'primary' && 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
        className,
      )}
    >
      {children}
    </button>
  )
}

// ── Текстовая раскладка (ЙЦУКЕН / QWERTY) ───────────────────────────────────
function TextPad({
  rows, shift, lang, onLetter, onChar, onBackspace, onShift, onLang, onDone,
}: {
  rows: string[][]
  shift: boolean
  lang: Lang
  onLetter: (ch: string) => void
  onChar: (ch: string) => void
  onBackspace: () => void
  onShift: () => void
  onLang: () => void
  onDone: () => void
}) {
  return (
    <div className="flex flex-col gap-1.5">
      {/* Цифровой ряд */}
      <div className="flex gap-1.5">
        {rows[0].map((d) => (
          <Key key={d} onTap={() => onChar(d)}>{d}</Key>
        ))}
      </div>
      {/* Буквенные ряды */}
      {rows.slice(1).map((row, i) => (
        <div key={i} className="flex gap-1.5">
          {/* Shift в начале последнего ряда */}
          {i === rows.length - 2 && (
            <Key onTap={onShift} variant={shift ? 'primary' : 'muted'} className="max-w-[64px]">
              <ArrowBigUp className="size-5" />
            </Key>
          )}
          {row.map((ch) => (
            <Key key={ch} onTap={() => onLetter(ch)}>
              {shift ? ch.toUpperCase() : ch}
            </Key>
          ))}
          {/* Backspace в конце последнего ряда */}
          {i === rows.length - 2 && (
            <Key onTap={onBackspace} variant="muted" className="max-w-[64px]">
              <Delete className="size-5" />
            </Key>
          )}
        </div>
      ))}
      {/* Нижний ряд: язык · запятая · пробел · точка · Готово */}
      <div className="flex gap-1.5">
        <Key onTap={onLang} variant="muted" className="max-w-[72px] gap-1 text-sm">
          <Globe className="size-4" />{lang === 'ru' ? 'РУС' : 'ENG'}
        </Key>
        <Key onTap={() => onChar(',')} variant="muted" className="max-w-[48px]">,</Key>
        <Key onTap={() => onChar(' ')} className="flex-[4]">Пробел</Key>
        <Key onTap={() => onChar('.')} variant="muted" className="max-w-[48px]">.</Key>
        <Key onTap={onDone} variant="primary" className="flex-[2] gap-1.5 text-base">
          <CornerDownLeft className="size-5" />Готово
        </Key>
      </div>
    </div>
  )
}

// ── Числовая раскладка (крупный пад) ────────────────────────────────────────
function NumericPad({
  onChar, onBackspace, onClear, onDone,
}: {
  onChar: (ch: string) => void
  onBackspace: () => void
  onClear: () => void
  onDone: () => void
}) {
  const NumKey = ({ children, onTap, variant = 'default', className }: {
    children: ReactNode; onTap: () => void; variant?: 'default' | 'muted' | 'primary'; className?: string
  }) => (
    <button
      type="button"
      onMouseDown={(e) => e.preventDefault()}
      onClick={onTap}
      className={cn(
        'flex h-16 items-center justify-center rounded-xl text-2xl font-semibold',
        'border transition-transform active:scale-95',
        variant === 'default' && 'border-border bg-background hover:bg-muted',
        variant === 'muted' && 'border-border bg-muted text-muted-foreground hover:bg-muted/70',
        variant === 'primary' && 'border-primary bg-primary text-primary-foreground hover:bg-primary/90',
        className,
      )}
    >
      {children}
    </button>
  )
  return (
    <div className="mx-auto grid max-w-sm grid-cols-3 gap-1.5">
      {['7', '8', '9', '4', '5', '6', '1', '2', '3'].map((d) => (
        <NumKey key={d} onTap={() => onChar(d)}>{d}</NumKey>
      ))}
      <NumKey onTap={() => onChar('.')} variant="muted">.</NumKey>
      <NumKey onTap={() => onChar('0')}>0</NumKey>
      <NumKey onTap={onBackspace} variant="muted"><Delete className="size-6" /></NumKey>
      <NumKey onTap={onClear} variant="muted" className="text-lg">Очистить</NumKey>
      <NumKey onTap={onDone} variant="primary" className="col-span-2 gap-2 text-lg">
        <CornerDownLeft className="size-5" />Готово
      </NumKey>
    </div>
  )
}
