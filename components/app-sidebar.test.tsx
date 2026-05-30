import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { renderHook, act } from '@testing-library/react'
import { useAppZoom } from './app-sidebar'

// v2.0.20 — useAppZoom: per-device UI scale 50-200% (step 10), persisted в
// localStorage 'restos.zoom', applied via document.documentElement.style.fontSize.
describe('useAppZoom', () => {
  beforeEach(() => {
    window.localStorage.clear()
    document.documentElement.style.fontSize = ''
  })

  afterEach(() => {
    window.localStorage.clear()
    document.documentElement.style.fontSize = ''
  })

  it('defaults to 100% when nothing in localStorage', () => {
    const { result } = renderHook(() => useAppZoom())
    expect(result.current.zoom).toBe(100)
    expect(document.documentElement.style.fontSize).toBe('100%')
  })

  it('reads saved zoom from localStorage on mount', () => {
    window.localStorage.setItem('restos.zoom', '130')
    const { result } = renderHook(() => useAppZoom())
    expect(result.current.zoom).toBe(130)
  })

  it('increase() adds 10% and persists', () => {
    const { result } = renderHook(() => useAppZoom())
    act(() => result.current.increase())
    expect(result.current.zoom).toBe(110)
    expect(window.localStorage.getItem('restos.zoom')).toBe('110')
    expect(document.documentElement.style.fontSize).toBe('110%')
  })

  it('decrease() subtracts 10% and persists', () => {
    const { result } = renderHook(() => useAppZoom())
    act(() => result.current.decrease())
    expect(result.current.zoom).toBe(90)
    expect(window.localStorage.getItem('restos.zoom')).toBe('90')
  })

  it('clamps to MIN (50%) even after many decreases', () => {
    const { result } = renderHook(() => useAppZoom())
    act(() => {
      for (let i = 0; i < 20; i++) result.current.decrease()
    })
    expect(result.current.zoom).toBe(50)
  })

  it('clamps to MAX (200%) even after many increases', () => {
    const { result } = renderHook(() => useAppZoom())
    act(() => {
      for (let i = 0; i < 20; i++) result.current.increase()
    })
    expect(result.current.zoom).toBe(200)
  })

  it('reset() returns to 100% and persists', () => {
    window.localStorage.setItem('restos.zoom', '150')
    const { result } = renderHook(() => useAppZoom())
    act(() => result.current.reset())
    expect(result.current.zoom).toBe(100)
    expect(window.localStorage.getItem('restos.zoom')).toBe('100')
  })

  it('clamps malformed localStorage to nearest valid step (NaN → 100, 137 → 140)', () => {
    window.localStorage.setItem('restos.zoom', 'garbage')
    const { result: a } = renderHook(() => useAppZoom())
    expect(a.current.zoom).toBe(100)

    window.localStorage.clear()
    window.localStorage.setItem('restos.zoom', '137')
    const { result: b } = renderHook(() => useAppZoom())
    expect(b.current.zoom).toBe(140) // rounded to step
  })
})
