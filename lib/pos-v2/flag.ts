// Флаг нового POS-интерфейса (Phase 0+1). Хранится на устройстве в localStorage,
// чтобы включать новый UI точечно на пилот-кассе, не трогая боевые терминалы.
// Старый POS остаётся дефолтом; выключение флага = мгновенный откат.
import { useEffect, useState } from 'react'

const KEY = 'pos_ui_v2'
const EVT = 'pos-v2:flag'

export function isPosV2Enabled(): boolean {
  try {
    return localStorage.getItem(KEY) === '1'
  } catch {
    return false
  }
}

export function setPosV2Enabled(on: boolean): void {
  try {
    localStorage.setItem(KEY, on ? '1' : '0')
    // Локальное событие — чтобы все подписчики в этой вкладке обновились сразу
    // (событие `storage` летит только в другие вкладки).
    window.dispatchEvent(new Event(EVT))
  } catch {
    /* ignore storage errors (private mode и т.п.) */
  }
}

/** Реактивный доступ к флагу: [значение, сеттер]. */
export function usePosV2Flag(): [boolean, (on: boolean) => void] {
  const [on, setOn] = useState<boolean>(isPosV2Enabled)
  useEffect(() => {
    const sync = () => setOn(isPosV2Enabled())
    window.addEventListener(EVT, sync)
    window.addEventListener('storage', sync)
    return () => {
      window.removeEventListener(EVT, sync)
      window.removeEventListener('storage', sync)
    }
  }, [])
  const set = (v: boolean) => {
    setPosV2Enabled(v)
    setOn(v)
  }
  return [on, set]
}
