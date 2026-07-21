'use client'

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type CSSProperties } from 'react'
import { Delete, ArrowBigUp, X, CornerDownLeft, Globe } from 'lucide-react'
import { cn } from '@/lib/utils'
import { useAuth } from '@/lib/auth-store'

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
  ['й', 'ц', 'у', 'к', 'е', 'н', 'г', 'ш', 'щ', 'з', 'х', 'ъ'],
  ['ё', 'ф', 'ы', 'в', 'а', 'п', 'р', 'о', 'л', 'д', 'ж', 'э'],
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

// Ближайший прокручиваемый предок (для инпутов на странице/инлайн-формах,
// которые не являются диалогами). Фоллбэк — сама страница.
function nearestScrollable(el: Element): HTMLElement {
  // Берём ближайшего предка со скроллом по стилю (даже если сейчас не
  // переполнен — после добавления нижнего паддинга ему будет куда скроллить).
  let node: HTMLElement | null = el.parentElement
  while (node && node !== document.body) {
    const oy = window.getComputedStyle(node).overflowY
    if (oy === 'auto' || oy === 'scroll') return node
    node = node.parentElement
  }
  return (document.scrollingElement as HTMLElement) || document.documentElement
}

function scrollPaneBy(sc: HTMLElement, delta: number) {
  if (sc === document.scrollingElement || sc === document.documentElement || sc === document.body) {
    window.scrollBy({ top: delta, behavior: 'smooth' })
  } else {
    sc.scrollBy({ top: delta, behavior: 'smooth' })
  }
}

// Пишем значение так, чтобы React (controlled inputs) увидел изменение.
function setNativeValue(el: HTMLInputElement | HTMLTextAreaElement, value: string) {
  const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype
  const desc = Object.getOwnPropertyDescriptor(proto, 'value')
  desc?.set?.call(el, value)
  el.dispatchEvent(new Event('input', { bubbles: true }))
}

export function OnScreenKeyboard() {
  // Включается в настройках владельца (Restaurant.onScreenKeyboardEnabled),
  // по умолчанию выключена. Гейтим тут, чтобы не трогать места рендера
  // (POS / смена / карта зала).
  const { restaurant } = useAuth()
  const enabled = restaurant?.onScreenKeyboardEnabled === true

  const [open, setOpen] = useState(false)
  const [layout, setLayout] = useState<Layout>('text')
  const [lang, setLang] = useState<Lang>('ru')
  const [shift, setShift] = useState(false)

  const activeRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const rootRef = useRef<HTMLDivElement>(null)
  const closeTimer = useRef<number | undefined>(undefined)
  // Функция отмены текущего «подъёма» (диалога или инлайн-формы) — восстанавливает
  // изменённые inline-стили. null, когда ничего не приподнято.
  const liftUndoRef = useRef<(() => void) | null>(null)
  // Инпут, под который уже сделан «подъём» — чтобы повторный focus (после нажатия
  // клавиши) не пересчитывал лифт и экран не «прыгал».
  const liftedForRef = useRef<Element | null>(null)

  const resetLift = useCallback(() => {
    liftUndoRef.current?.()
    liftUndoRef.current = null
    liftedForRef.current = null
  }, [])

  // Сделать так, чтобы клавиатура не перекрывала фокусный инпут и кнопки под ним.
  //  • Центрированный диалог (Radix, role="dialog") — приподнимаем margin-top'ом.
  //  • Инпут на странице / инлайн-форма (смена) — резервируем место снизу у
  //    скролл-контейнера и подскролливаем инпут в верх видимой полосы.
  const applyLift = useCallback((active: Element | null) => {
    if (active && active === liftedForRef.current) return // уже подняли под этот инпут
    resetLift()
    liftedForRef.current = active
    const kb = rootRef.current
    if (!kb || !active) return
    const gap = 12
    const kbHeight = kb.offsetHeight
    const kbTop = window.innerHeight - kbHeight

    // 1) Центрированный диалог — поднимаем целиком. AlertDialog рендерится
    //    с role="alertdialog", обычный Dialog — role="dialog".
    const host = active.closest('[role="dialog"], [role="alertdialog"]') as HTMLElement | null
    if (host && window.getComputedStyle(host).top !== 'auto') {
      const rect = host.getBoundingClientRect()
      if (rect.bottom <= kbTop - gap) return // уже не перекрыт
      // Цифровая панель пришвартована к правому краю и с центрированным
      // диалогом по горизонтали не пересекается — поднимать и ужимать его
      // незачем. Без этой проверки диалог всё равно получал maxHeight и
      // внутренний скролл, и кнопка подтверждения уезжала под срез, хотя
      // клавиатура её ничем не закрывала.
      const kbRect = kb.getBoundingClientRect()
      if (rect.right <= kbRect.left || rect.left >= kbRect.right) return
      const prev = {
        marginTop: host.style.marginTop, maxHeight: host.style.maxHeight,
        overflowY: host.style.overflowY, transition: host.style.transition,
      }
      const lift = Math.min(rect.bottom - (kbTop - gap), Math.max(0, rect.top - gap))
      host.style.transition = 'margin-top 160ms ease'
      host.style.marginTop = `-${lift}px`
      // Диалог всё равно выше доступной полосы → ограничиваем высоту + внутр. скролл.
      const band = (kbTop - gap) - (rect.top - lift)
      if (host.scrollHeight > band + 1) {
        host.style.maxHeight = `${Math.max(160, band)}px`
        host.style.overflowY = 'auto'
        window.setTimeout(() => active.scrollIntoView?.({ block: 'center', behavior: 'smooth' }), 0)
      }
      liftUndoRef.current = () => {
        host.style.marginTop = prev.marginTop
        host.style.maxHeight = prev.maxHeight
        host.style.overflowY = prev.overflowY
        host.style.transition = prev.transition
      }
      return
    }

    // 2) Низовой drawer (vaul) с НАШЕЙ on-screen-клавиатурой: нативной клавиатуры
    //    нет (иначе applyLift не вызывался бы вовсе), поэтому НЕ выходим рано —
    //    даём скролл-контейнеру внутри drawer'а подскроллить инпут над
    //    клавиатурой (логика ниже). Раньше тут был `return`, и клавиатура
    //    перекрывала нижнюю панель — например, смешанную оплату.

    // 3) Инпут на странице/инлайн-форме/в нижнем drawer'е: добавляем нижний
    //    паддинг скролл-контейнеру,
    //    чтобы под клавиатурой было куда прокрутить, и поднимаем инпут в верхнюю
    //    треть видимой полосы — тогда кнопки под ним тоже остаются видимыми.
    const sc = nearestScrollable(active)
    const prevPad = sc.style.paddingBottom
    const basePad = parseFloat(window.getComputedStyle(sc).paddingBottom) || 0
    sc.style.paddingBottom = `${basePad + kbHeight}px`
    liftUndoRef.current = () => { sc.style.paddingBottom = prevPad }
    window.setTimeout(() => {
      const r = active.getBoundingClientRect()
      const targetTop = (window.innerHeight - kbHeight) * 0.3
      const delta = r.top - targetTop
      if (Math.abs(delta) > 4) scrollPaneBy(sc, delta)
    }, 0)
  }, [resetLift])

  // ── focus tracking (POS-scoped: слушатели живут пока компонент смонтирован) ──
  useEffect(() => {
    // Клавиатура выключена в настройках — не вешаем слушатели вовсе.
    if (!enabled) { setOpen(false); return }
    const onFocusIn = (e: FocusEvent) => {
      const el = e.target as Element | null
      if (!isTypeable(el)) return
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      // Тот же инпут (повторный фокус после нажатия клавиши на тач-экране) —
      // не сбрасываем раскладку/Shift и не дёргаем лифт (иначе экран прыгает).
      const sameInput = activeRef.current === el
      activeRef.current = el
      if (!sameInput) {
        setLayout(layoutFor(el))
        setShift(false)
        setOpen(true)
      }
      // После рендера клавиатуры (знаем её высоту) убираем перекрытие: диалог
      // приподнимаем, инпут на странице/инлайн-форме — подскролливаем над
      // клавиатурой вместе с кнопками под ним.
      window.setTimeout(() => applyLift(el), sameInput ? 0 : 70)
    }
    const onFocusOut = () => {
      // Консервативное закрытие (с задержкой — дать focusin перехватить
      // переключение между полями). НЕ закрываем, если фокус ушёл «в никуда»
      // (промах мимо поля → body) или попал внутрь самой клавиатуры — иначе
      // клавиатура исчезала при каждом тапе по клавише/мимо. Закрываем только
      // когда поле удалено из DOM или фокус ушёл на реальный внешний контрол.
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      closeTimer.current = window.setTimeout(() => {
        const el = activeRef.current
        if (!el || !el.isConnected) { resetLift(); setOpen(false); activeRef.current = null; return }
        const ae = document.activeElement
        if (!ae || ae === document.body || ae === document.documentElement) return // промах — оставляем
        if (isTypeable(ae)) return                  // переключение на другой инпут — обработает focusin
        if (rootRef.current?.contains(ae)) return   // фокус внутри клавиатуры — оставляем
        resetLift(); setOpen(false); activeRef.current = null
      }, 200)
    }
    document.addEventListener('focusin', onFocusIn)
    document.addEventListener('focusout', onFocusOut)
    return () => {
      document.removeEventListener('focusin', onFocusIn)
      document.removeEventListener('focusout', onFocusOut)
      if (closeTimer.current) window.clearTimeout(closeTimer.current)
      resetLift()
    }
  }, [enabled, applyLift, resetLift])

  // Не даём pointerdown по клавиатуре всплыть до document — иначе Radix-диалоги
  // закрылись бы по «клику снаружи». На mousedown ещё и preventDefault — чтобы
  // тап по клавише не уводил фокус с инпута (на десктопе фокус меняется на
  // mousedown). На pointerdown preventDefault не зовём — иначе на тач-экране
  // подавился бы click клавиши.
  useEffect(() => {
    const root = rootRef.current
    if (!root) return
    const onPointerDown = (e: Event) => e.stopPropagation()
    const onMouseDown = (e: Event) => { e.preventDefault(); e.stopPropagation() }
    root.addEventListener('pointerdown', onPointerDown)
    root.addEventListener('mousedown', onMouseDown)
    return () => {
      root.removeEventListener('pointerdown', onPointerDown)
      root.removeEventListener('mousedown', onMouseDown)
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
    resetLift()
    setOpen(false)
  }, [resetLift])

  const handleLetter = useCallback((ch: string) => {
    applyChar(shift ? ch.toUpperCase() : ch)
    if (shift) setShift(false) // авто-сброс Shift после буквы (как на телефоне)
  }, [applyChar, shift])

  const rows = useMemo(() => (lang === 'ru' ? RU_ROWS : EN_ROWS), [lang])

  if (!enabled || !open) return null

  return (
    <div
      ref={rootRef}
      data-no-vk
      className={cn(
        // pointer-events-auto: модальные Radix-диалоги (Dialog/AlertDialog)
        // ставят pointer-events:none на <body> — без явного auto клавиатура
        // видна (z-90), но не кликабельна.
        'fixed bottom-0 z-[90] select-none pointer-events-auto',
        'shadow-2xl',
        'px-4 pt-2.5 pb-[max(1rem,env(safe-area-inset-bottom))]',
        'animate-in slide-in-from-bottom-4 duration-150',
        // Буквенная раскладка занимает всю ширину — иначе клавиши не влезают.
        // Цифровая собирается в панель по центру: на широком кассовом мониторе
        // лоток во всю ленту закрывал низ диалога целиком, включая кнопку
        // подтверждения, хотя сами клавиши занимали лишь треть.
        // Цифровая панель прижата к ПРАВОМУ краю и узкая (22rem). Диалоги
        // центрированы и шире 30rem; при панели по центру или во всю ленту
        // она перекрывала им низ — кнопку подтверждения приходилось
        // доскроллить. Справа и в такой ширине пересечения нет, поэтому
        // подъём диалога вообще не включается (см. applyLift). На узком
        // экране ширина упирается в 100vw и поведение вырождается в прежнее.
        layout === 'numeric'
          ? 'right-0 w-[min(22rem,100vw)] rounded-tl-2xl'
          : 'inset-x-0',
      )}
      // Дизайн restos.pen (Keyboard Wrap): бежевый лоток #E6E3DB, клавиши белые.
      style={{ background: '#E6E3DB', border: '1px solid #D5D1C9', borderBottom: 'none' }}
    >
      {/* Цифровой блок не растягиваем на всю ленту экрана: на кассовом
          мониторе это полтора метра пустых клавиш, а перекрывает он при этом
          весь низ диалога — поле суммы и кнопку отправки. Буквенной раскладке
          ширина нужна вся, ей ограничение не ставим. */}
      <div className={cn('w-full', layout === 'numeric' && 'mx-auto max-w-[26rem]')}>
        {/* Хедер: ручка + закрыть */}
        <div className="relative flex items-center justify-center py-1.5">
          <div className="h-1 w-10 rounded-full" style={{ background: '#C4BFB4' }} />
          <button
            type="button"
            tabIndex={-1}
            aria-label="Скрыть клавиатуру"
            onClick={applyDone}
            className="absolute right-0 top-1/2 -translate-y-1/2 grid size-9 place-items-center rounded-[10px] active:scale-95 touch-manipulation"
            style={{ background: '#D5D1C9', color: '#3A382F' }}
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
            onClear={applyClear}
            onShift={() => { setShift((s) => !s); activeRef.current?.focus() }}
            onLang={() => { setLang((l) => (l === 'ru' ? 'en' : 'ru')); activeRef.current?.focus() }}
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
      tabIndex={-1}
      // Фокус удерживаем глобально (preventDefault mousedown на корне клавиатуры),
      // поэтому сама клавиша — просто onClick. touch-manipulation убирает задержку.
      onClick={onTap}
      className={cn(
        'flex h-14 flex-1 items-center justify-center rounded-[10px] text-xl font-medium touch-manipulation',
        'transition-transform active:scale-[0.97]',
        className,
      )}
      // Дизайн restos.pen: белые клавиши с мягкой тенью; действия — бежевые
      // #D5D1C9; праймери (Enter/язык-акцент) — бренд #D85A30.
      style={KEY_STYLE[variant]}
    >
      {children}
    </button>
  )
}

// Палитра клавиш из restos.pen (Keyboard Wrap).
const KEY_STYLE: Record<'default' | 'muted' | 'primary', CSSProperties> = {
  default: { background: '#FFFFFF', color: '#1A1A1A', boxShadow: '0 1px 2px rgba(0,0,0,0.08)' },
  muted: { background: '#D5D1C9', color: '#3A382F' },
  primary: { background: '#D85A30', color: '#FFFFFF' },
}

// ── Текстовая раскладка (ЙЦУКЕН / QWERTY, на всю ширину, iiko-style) ─────────
function TextPad({
  rows, shift, lang, onLetter, onChar, onBackspace, onClear, onShift, onLang, onDone,
}: {
  rows: string[][]
  shift: boolean
  lang: Lang
  onLetter: (ch: string) => void
  onChar: (ch: string) => void
  onBackspace: () => void
  onClear: () => void
  onShift: () => void
  onLang: () => void
  onDone: () => void
}) {
  const disp = (ch: string) => (shift ? ch.toUpperCase() : ch)
  return (
    <div className="flex flex-col gap-1.5">
      {/* Цифровой ряд + Backspace */}
      <div className="flex gap-1.5">
        {rows[0].map((d) => (
          <Key key={d} onTap={() => onChar(d)}>{d}</Key>
        ))}
        <Key onTap={onBackspace} variant="muted" className="flex-[1.5]">
          <Delete className="size-5" />
        </Key>
      </div>
      {/* Буквенный ряд 1 */}
      <div className="flex gap-1.5">
        {rows[1].map((ch) => (
          <Key key={ch} onTap={() => onLetter(ch)}>{disp(ch)}</Key>
        ))}
      </div>
      {/* Буквенный ряд 2 */}
      <div className="flex gap-1.5">
        {rows[2].map((ch) => (
          <Key key={ch} onTap={() => onLetter(ch)}>{disp(ch)}</Key>
        ))}
      </div>
      {/* Буквенный ряд 3: Регистр + буквы + Enter */}
      <div className="flex gap-1.5">
        <Key onTap={onShift} variant={shift ? 'primary' : 'muted'} className="flex-[1.7] gap-1 text-sm">
          <ArrowBigUp className="size-5" />Регистр
        </Key>
        {rows[3].map((ch) => (
          <Key key={ch} onTap={() => onLetter(ch)}>{disp(ch)}</Key>
        ))}
        <Key onTap={() => onChar('.')} variant="muted">.</Key>
        <Key onTap={onDone} variant="primary" className="flex-[2] gap-1.5 text-base">
          <CornerDownLeft className="size-5" />Enter
        </Key>
      </div>
      {/* Нижний ряд: язык · запятая · пробел · «Стереть все» */}
      <div className="flex gap-1.5">
        <Key onTap={onLang} variant="muted" className="flex-[1.5] gap-1.5 text-base">
          <Globe className="size-4" />{lang === 'ru' ? 'РУС' : 'EN'}
        </Key>
        <Key onTap={() => onChar(',')} variant="muted">,</Key>
        <Key onTap={() => onChar(' ')} className="flex-[6]">Пробел</Key>
        <Key onTap={onClear} variant="muted" className="flex-[1.8] text-base">Стереть все</Key>
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
      tabIndex={-1}
      onClick={onTap}
      className={cn(
        // Высота клавиши: было h-16/68px — четыре ряда съедали треть экрана
        // и прятали содержимое диалога. 52/56px остаются комфортными для
        // пальца (рекомендованный минимум тач-цели — 44px).
        'flex h-[52px] items-center justify-center rounded-[10px] text-2xl font-semibold touch-manipulation',
        'transition-transform active:scale-[0.97] sm:h-[56px]',
        className,
      )}
      style={KEY_STYLE[variant]}
    >
      {children}
    </button>
  )
  // На всю ширину: 3 колонки цифр + колонка действий (как iiko-нумпад).
  return (
    <div className="grid grid-cols-4 gap-1.5">
      <NumKey onTap={() => onChar('7')}>7</NumKey>
      <NumKey onTap={() => onChar('8')}>8</NumKey>
      <NumKey onTap={() => onChar('9')}>9</NumKey>
      <NumKey onTap={onBackspace} variant="muted"><Delete className="size-6" /></NumKey>

      <NumKey onTap={() => onChar('4')}>4</NumKey>
      <NumKey onTap={() => onChar('5')}>5</NumKey>
      <NumKey onTap={() => onChar('6')}>6</NumKey>
      <NumKey onTap={onClear} variant="muted" className="text-base">Стереть</NumKey>

      <NumKey onTap={() => onChar('1')}>1</NumKey>
      <NumKey onTap={() => onChar('2')}>2</NumKey>
      <NumKey onTap={() => onChar('3')}>3</NumKey>
      <NumKey onTap={() => onChar('.')} variant="muted">.</NumKey>

      <NumKey onTap={() => onChar('0')} className="col-span-2">0</NumKey>
      <NumKey onTap={onDone} variant="primary" className="col-span-2 gap-2 text-lg">
        <CornerDownLeft className="size-5" />Готово
      </NumKey>
    </div>
  )
}
