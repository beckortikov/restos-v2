'use client'

import { useState, useEffect } from 'react'

interface DecimalInputProps {
  value: number | null | undefined
  onChange: (v: number) => void
  className?: string
  placeholder?: string
  min?: number
  max?: number
  disabled?: boolean
  autoFocus?: boolean
}

function valueToText(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(v)) return ''
  if (v === 0) return ''
  return String(v)
}

/**
 * Number input that properly supports decimal values (0.5, 1.25, etc.)
 * Works with both dot (.) and comma (,) as decimal separators.
 *
 * Replaces `<input type="number" value={val || ''} onChange={e => set(parseFloat(e.target.value) || 0)} />`
 * which breaks when typing "0." because parseFloat("0.") returns 0, resetting the input.
 */
export function DecimalInput({ value, onChange, className, placeholder, min, max, disabled, autoFocus }: DecimalInputProps) {
  const [text, setText] = useState(() => valueToText(value))
  const [focused, setFocused] = useState(false)

  // Sync from parent when not focused
  useEffect(() => {
    if (!focused) setText(valueToText(value))
  }, [value, focused])

  return (
    <input
      type="text"
      inputMode="decimal"
      disabled={disabled}
      autoFocus={autoFocus}
      value={focused ? text : valueToText(value)}
      placeholder={placeholder}
      onFocus={() => {
        setFocused(true)
        setText(valueToText(value))
      }}
      onBlur={() => {
        setFocused(false)
        const num = parseFloat(text.replace(',', '.')) || 0
        const clamped = min !== undefined ? Math.max(min, num) : num
        const final = max !== undefined ? Math.min(max, clamped) : clamped
        onChange(final)
      }}
      onChange={(e) => {
        const v = e.target.value.replace(',', '.')
        if (v === '' || v === '.' || /^\d*\.?\d*$/.test(v)) {
          setText(v)
          const num = parseFloat(v)
          if (!isNaN(num)) {
            onChange(num)
          }
        }
      }}
      className={className}
    />
  )
}
