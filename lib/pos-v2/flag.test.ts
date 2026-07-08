import { describe, it, expect, beforeEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { isPosV2Enabled, setPosV2Enabled, usePosV2Flag } from './flag'

describe('pos_ui_v2 flag', () => {
  beforeEach(() => window.localStorage.clear())

  it('по умолчанию выключен', () => {
    expect(isPosV2Enabled()).toBe(false)
  })
  it('включение пишет "1" и читается', () => {
    setPosV2Enabled(true)
    expect(window.localStorage.getItem('pos_ui_v2')).toBe('1')
    expect(isPosV2Enabled()).toBe(true)
  })
  it('выключение пишет "0"', () => {
    setPosV2Enabled(true)
    setPosV2Enabled(false)
    expect(window.localStorage.getItem('pos_ui_v2')).toBe('0')
    expect(isPosV2Enabled()).toBe(false)
  })
  it('любое значение кроме "1" = выключено', () => {
    window.localStorage.setItem('pos_ui_v2', 'yes')
    expect(isPosV2Enabled()).toBe(false)
  })
})

describe('usePosV2Flag', () => {
  beforeEach(() => window.localStorage.clear())

  it('сеттер меняет значение реактивно', () => {
    const { result } = renderHook(() => usePosV2Flag())
    expect(result.current[0]).toBe(false)
    act(() => result.current[1](true))
    expect(result.current[0]).toBe(true)
    expect(isPosV2Enabled()).toBe(true)
  })

  it('подхватывает внешний setPosV2Enabled через событие (реактивность между компонентами)', () => {
    const { result } = renderHook(() => usePosV2Flag())
    act(() => setPosV2Enabled(true))
    expect(result.current[0]).toBe(true)
  })
})
