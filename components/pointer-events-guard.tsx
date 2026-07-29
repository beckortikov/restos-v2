'use client'

import { useEffect } from 'react'
import { useLocation } from 'react-router-dom'

// PointerEventsGuard — снимает залипающий `body { pointer-events: none }` от Radix.
//
// Модальные Radix-слои (Dialog/AlertDialog/Popover/DropdownMenu/Select с modal)
// на время открытия ставят `document.body.style.pointerEvents='none'` (чтобы клики
// шли только в слой) и возвращают исходное значение в cleanup. В установленной
// версии (@radix-ui/react-dialog@1.1.15 → react-dismissable-layer@1.1.11) возврат
// завязан на модульную переменную + проверку `size === 1` и ИНОГДА проигрывает
// гонку — особенно когда закрытие батчится с тяжёлым ре-рендером и монтированием
// портала тоста (форма «Новое блюдо» → диалог быстрого создания продукта). Тогда
// `body` остаётся `pointer-events:none`: вся страница «мертва», инпуты и кнопки не
// реагируют до жёсткой перезагрузки. Это давно известный баг Radix этих версий.
//
// Guard монтируется один раз в корне (внутри Router) и сбрасывает блокировку,
// когда она «осиротела» — body заблокирован, но НИ ОДНОГО открытого Radix-слоя в
// DOM нет. Признак открытого слоя — edge-guard'ы `[data-radix-focus-guard]`
// (их ставит react-focus-guards, пока жив хотя бы один модальный слой). Пока они
// есть — не трогаем, чтобы не пробить блокировку фона у реально открытой модалки.

// hasOpenRadixModal — есть ли в DOM РЕАЛЬНО открытый модальный слой Radix:
// контент диалога/меню/списка с data-state="open" либо popper-обёртка/оверлей.
// Пока он есть — блокировка фона легитимна. Проверяем именно data-state="open",
// а НЕ [data-radix-focus-guard]: edge-guard'ы могут остаться в DOM после закрытия
// диалога (та же гонка Radix, что оставляет body pointer-events:none) — и тогда
// «осиротевшую» блокировку было не снять, инпуты оставались мёртвыми (форма
// «Новая накладная»: поиск поставщика/дата, форма «Новое блюдо»).
function hasOpenRadixModal(): boolean {
  return !!document.querySelector(
    '[role="dialog"][data-state="open"], [role="alertdialog"][data-state="open"], ' +
    '[role="menu"][data-state="open"], [role="listbox"][data-state="open"], ' +
    '[data-radix-popper-content-wrapper]',
  )
}

export function unstickBodyPointerEvents() {
  if (typeof document === 'undefined') return
  const body = document.body
  if (body.style.pointerEvents !== 'none') return
  if (hasOpenRadixModal()) return // модалка реально открыта — блокировка нужна
  body.style.pointerEvents = ''
}

export function PointerEventsGuard() {
  const location = useLocation()

  useEffect(() => {
    const body = document.body
    let raf = 0
    const schedule = () => {
      cancelAnimationFrame(raf)
      // rAF-defer: даём Radix доиграть собственный cleanup, прежде чем решать
      // (и focus-guard'ам открывающейся модалки — появиться, чтобы не пробить её).
      raf = requestAnimationFrame(unstickBodyPointerEvents)
    }
    // attributes/style — ловим сам момент блокировки; childList — анмаунт портала
    // диалога (именно тогда focus-guard'ы исчезают, а осиротевший 'none' надо снять).
    const obs = new MutationObserver(schedule)
    obs.observe(body, { attributes: true, attributeFilter: ['style'], childList: true })
    return () => {
      obs.disconnect()
      cancelAnimationFrame(raf)
    }
  }, [])

  // Страховка: при смене роута тоже снимаем возможное залипание (например форма
  // ушла в navigate, пока слой закрывался).
  useEffect(() => {
    unstickBodyPointerEvents()
  }, [location.pathname])

  return null
}
