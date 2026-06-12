// lib/theme.ts — переключение светлой/тёмной темы.
//
// Тема персистится в localStorage и применяется добавлением класса `.dark`
// на <html>. CSS-переменные тёмной темы уже определены в src/index.css.
//
// Три режима: 'light' | 'dark' | 'system' (следует за ОС).

export type ThemeMode = 'light' | 'dark' | 'system'

const STORAGE_KEY = 'restos.theme'

export function getStoredTheme(): ThemeMode {
  if (typeof window === 'undefined') return 'light'
  const v = localStorage.getItem(STORAGE_KEY)
  if (v === 'dark' || v === 'light' || v === 'system') return v
  return 'light' // дефолт — светлая (касса по умолчанию)
}

// resolveTheme — превращает 'system' в фактический 'light'|'dark'.
export function resolveTheme(mode: ThemeMode): 'light' | 'dark' {
  if (mode === 'system') {
    if (typeof window !== 'undefined' && window.matchMedia) {
      return window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'
    }
    return 'light'
  }
  return mode
}

// applyTheme — вешает/снимает класс .dark на <html>.
export function applyTheme(mode: ThemeMode): void {
  if (typeof document === 'undefined') return
  const resolved = resolveTheme(mode)
  const root = document.documentElement
  if (resolved === 'dark') root.classList.add('dark')
  else root.classList.remove('dark')
}

// setTheme — сохраняет и применяет.
export function setTheme(mode: ThemeMode): void {
  if (typeof window !== 'undefined') localStorage.setItem(STORAGE_KEY, mode)
  applyTheme(mode)
  // Уведомляем подписчиков (toggle в шапке и т.п.) — без глобального стора.
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent('restos-theme-change', { detail: mode }))
  }
}

// initTheme — вызывается один раз при старте приложения (до рендера).
//
// v3.9.16: тёмная тема отключена по решению — форсируем светлую и чистим
// сохранённый выбор, чтобы у тех, кто успел включить dark, вернулась
// светлая. CSS-токены .dark остаются в коде на будущее, но не активируются.
export function initTheme(): void {
  if (typeof document !== 'undefined') {
    document.documentElement.classList.remove('dark')
  }
  if (typeof window !== 'undefined') {
    localStorage.removeItem(STORAGE_KEY)
  }
}
