'use client'

import { forwardRef } from 'react'
import type { MenuStation } from '@/lib/types'
import { STATION_LABELS, STATION_ICONS } from '@/lib/types'

export interface RunnerData {
  orderId: string
  orderNumber: string // short ID or sequential number
  station: MenuStation
  tableName?: string
  zoneName?: string
  guestsCount?: number
  orderType: 'hall' | 'delivery' | 'takeaway'
  waiterName?: string
  items: { name: string; qty: number; modifiers?: string[]; unit?: 'piece' | 'g' | 'kg'; unitSize?: number }[]
  createdAt: string
  comment?: string
}

export const PrintRunner = forwardRef<HTMLDivElement, { data: RunnerData }>(({ data }, ref) => {
  const time = new Date(data.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
  const date = new Date(data.createdAt).toLocaleDateString('ru', { day: '2-digit', month: '2-digit' })
  const typeLabel = data.orderType === 'hall' ? 'Зал' : data.orderType === 'delivery' ? 'Доставка' : 'Самовывоз'

  return (
    <div ref={ref} style={{ fontFamily: 'monospace', fontSize: '14px', width: '280px', padding: '8px', color: '#000', background: '#fff' }}>
      {/* Station header — big and bold */}
      <div style={{ textAlign: 'center', marginBottom: '8px', borderBottom: '2px solid #000', paddingBottom: '6px' }}>
        <div style={{ fontSize: '18px', fontWeight: 'bold' }}>
          {STATION_ICONS[data.station]} {STATION_LABELS[data.station]}
        </div>
      </div>

      {/* Order info */}
      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '4px' }}>
        <span style={{ fontWeight: 'bold', fontSize: '16px' }}>#{data.orderNumber}</span>
        <span>{time} · {date}</span>
      </div>

      <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', marginBottom: '6px' }}>
        <span style={{ fontWeight: 'bold' }}>{data.tableName || typeLabel}</span>
        {data.waiterName && <span>Оф: {data.waiterName}</span>}
      </div>

      {/* Divider */}
      <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />

      {/* Items — large font for kitchen */}
      {data.items.map((item, i) => (
        <div key={i} style={{ marginBottom: '6px' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '16px', fontWeight: 'bold' }}>
            <span>{item.name}</span>
            <span>{item.unit === 'g' ? `${Math.round(item.qty)}г` : item.unit === 'kg' ? `${Number(item.qty).toFixed(item.qty < 10 ? 2 : 1).replace(/\.?0+$/, '')}кг` : `x${item.qty}`}</span>
          </div>
          {item.modifiers && item.modifiers.length > 0 && (
            <div style={{ fontSize: '12px', color: '#444', paddingLeft: '8px' }}>
              {item.modifiers.map((m, mi) => <div key={mi}>+ {m}</div>)}
            </div>
          )}
        </div>
      ))}

      {/* Comment */}
      {data.comment && (
        <>
          <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />
          <div style={{ fontSize: '12px', fontStyle: 'italic' }}>
            Комментарий: {data.comment}
          </div>
        </>
      )}

      {/* Footer */}
      <div style={{ borderTop: '1px dashed #000', margin: '8px 0 4px' }} />
      <div style={{ textAlign: 'center', fontSize: '10px', color: '#888' }}>
        RestOS · Марка
      </div>
    </div>
  )
})

PrintRunner.displayName = 'PrintRunner'

// Generate HTML for thermal printer pixel mode (supports Cyrillic)
export function generateRunnerHtml(data: RunnerData): string {
  const d = new Date(data.createdAt)
  const months = ['янв', 'фев', 'мар', 'апр', 'май', 'июн', 'июл', 'авг', 'сен', 'окт', 'ноя', 'дек']
  const dateStr = `${d.getDate()} ${months[d.getMonth()]} ${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`
  const typeLabel = data.orderType === 'hall' ? 'Зал' : data.orderType === 'delivery' ? 'Доставка' : 'Самовывоз'
  const station = STATION_LABELS[data.station]

  let items = ''
  for (const item of data.items) {
    items += `<tr><td style="font-size:14px;font-weight:bold;padding:1px 0">${item.name}</td><td style="font-size:14px;font-weight:bold;text-align:right;padding:1px 0;white-space:nowrap">${item.unit === 'g' ? Math.round(item.qty) + 'г' : item.unit === 'kg' ? Number(item.qty).toFixed(item.qty < 10 ? 2 : 1).replace(/\.?0+$/, '') + 'кг' : 'x' + item.qty}</td></tr>`
    if (item.modifiers?.length) {
      for (const m of item.modifiers) {
        items += `<tr><td colspan="2" style="font-size:10px;color:#444;padding-left:4px">+ ${m}</td></tr>`
      }
    }
  }

  const tableLabel = data.tableName
    ? (String(data.tableName).toLowerCase().startsWith('стол') ? String(data.tableName) : `Стол ${data.tableName}`)
    : ''
  const zoneLabel = data.zoneName || (data.orderType === 'hall' ? '' : typeLabel)
  const guestsLabel = data.guestsCount ? `${data.guestsCount} гост.` : ''
  const infoParts = [tableLabel, zoneLabel, guestsLabel].filter(Boolean).join(', ')

  return `<html><head><meta charset="utf-8"><style>*{margin:0;padding:0;box-sizing:border-box}body{font-family:Arial,sans-serif;width:76mm;padding:1mm 2mm;color:#000;line-height:1.2;font-size:12px}</style></head><body>
<div style="text-align:center;font-size:14px;font-weight:bold;border-bottom:1px solid #000;padding-bottom:2px;margin-bottom:2px">${station.toUpperCase()}</div>
<div>${dateStr} Зак: ${data.orderNumber}${data.waiterName ? ' ' + data.waiterName : ''}</div>
<div style="font-weight:bold">${infoParts}</div>
<div style="border-top:1px dashed #000;margin:2px 0"></div>
<table style="width:100%;border-collapse:collapse">${items}</table>
${data.comment ? `<div style="border-top:1px dashed #000;margin:2px 0"></div><div style="font-style:italic">! ${data.comment}</div>` : ''}
</body></html>`
}

// Generate ESC/POS raw text for thermal printer (no graphics, plain text)
export function generateRunnerText(data: RunnerData): string {
  const time = new Date(data.createdAt).toLocaleTimeString('ru', { hour: '2-digit', minute: '2-digit' })
  const typeLabel = data.orderType === 'hall' ? 'Зал' : data.orderType === 'delivery' ? 'Доставка' : 'Самовывоз'
  const station = STATION_LABELS[data.station]

  let text = ''
  text += `\n`
  text += `    === ${station.toUpperCase()} ===\n`
  text += `\n`
  text += `Заказ: #${data.orderNumber}  ${time}\n`
  text += `${data.tableName || typeLabel}`
  if (data.waiterName) text += `  Оф: ${data.waiterName}`
  text += `\n`
  text += `--------------------------------\n`

  for (const item of data.items) {
    text += `${item.name}`.padEnd(24) + (item.unit === 'g' ? `${Math.round(item.qty)}г` : item.unit === 'kg' ? `${Number(item.qty).toFixed(item.qty < 10 ? 2 : 1).replace(/\.?0+$/, '')}кг` : `x${item.qty}`) + '\n'
    if (item.modifiers) {
      for (const m of item.modifiers) {
        text += `  + ${m}\n`
      }
    }
  }

  if (data.comment) {
    text += `--------------------------------\n`
    text += `! ${data.comment}\n`
  }

  text += `--------------------------------\n`
  text += `         RestOS\n\n\n`

  return text
}
