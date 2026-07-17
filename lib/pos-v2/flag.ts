// Флаг нового POS-интерфейса (Phase 0+1). Хранится на устройстве в localStorage,
// чтобы включать новый UI точечно на пилот-кассе, не трогая боевые терминалы.
// Старый POS остаётся дефолтом; выключение флага = мгновенный откат.
import { useEffect, useState } from 'react'

const KEY = 'pos_ui_v2'            // явный выбор устройства: '1' | '0' | нет
const DEFAULT_KEY = 'pos_ui_v2_default' // дефолт ресторана (posV2Default), синкается из БД
const EVT = 'pos-v2:flag'

// Решение с ЯВНО переданным дефолтом ресторана — без гонки с синком в
// localStorage. Нужно для homeRoute сразу после логина: там restaurant уже есть,
// а syncPosV2Default мог ещё не отработать.
// Приоритет: явный выбор кассы (pos_ui_v2) > дефолт ресторана.
export function isPosV2EnabledFor(restaurantDefault: boolean): boolean {
  try {
    const v = localStorage.getItem(KEY)
    if (v === '1') return true
    if (v === '0') return false
    return restaurantDefault
  } catch {
    return false
  }
}

export function isPosV2Enabled(): boolean {
  try {
    // Нет явного выбора на этой кассе → дефолт ресторана (owner-настройка
    // «Новый POS по умолчанию»). Если и его нет — классический POS.
    return isPosV2EnabledFor(localStorage.getItem(DEFAULT_KEY) === '1')
  } catch {
    return false
  }
}

// Синк дефолта ресторана (Restaurant.posV2Default) в localStorage. Кассы без
// явного выбора следуют этому дефолту; кассы, где кассир переключил вручную
// (setPosV2Enabled), сохраняют свой выбор.
export function syncPosV2Default(on: boolean): void {
  try {
    const next = on ? '1' : '0'
    if (localStorage.getItem(DEFAULT_KEY) !== next) {
      localStorage.setItem(DEFAULT_KEY, next)
      window.dispatchEvent(new Event(EVT))
    }
  } catch {
    /* ignore */
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
