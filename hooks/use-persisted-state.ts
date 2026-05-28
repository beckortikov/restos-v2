import { useEffect, useState } from 'react'

export function usePersistedState<T extends string>(key: string, initial: T): [T, (v: T) => void] {
  const [value, setValue] = useState<T>(() => {
    if (typeof window === 'undefined') return initial
    const stored = window.localStorage.getItem(key)
    return (stored as T) ?? initial
  })

  useEffect(() => {
    if (typeof window === 'undefined') return
    window.localStorage.setItem(key, value)
  }, [key, value])

  return [value, setValue]
}
