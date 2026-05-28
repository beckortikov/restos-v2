'use client'

import { forwardRef } from 'react'
import { formatCurrency, calcLineTotal, formatQty } from '@/lib/helpers'
import type { PaymentMethod } from '@/lib/types'
import type { ReceiptPrintData } from '@/lib/print-service'

const PAYMENT_LABELS: Record<PaymentMethod, string> = {
  cash: 'Наличные',
  card: 'Безналичные',
  transfer: 'Безналичные',
}

// Единый тип данных чека — общий для HTML preview и ESC/POS термопечати,
// чтобы вёрстка и печать строились из одного и того же объекта без дрейфа
// полей. См. lib/receipt-data.ts buildReceiptData.
export type ReceiptData = ReceiptPrintData

interface PrintReceiptProps {
  data: ReceiptData
}

const TYPE_LABELS: Record<string, string> = {
  hall: 'Зал',
  delivery: 'Доставка',
  takeaway: 'Самовывоз',
}

export const PrintReceipt = forwardRef<HTMLDivElement, PrintReceiptProps>(
  function PrintReceipt({ data }, ref) {
    const now = new Date(data.closedAt)
    const dateStr = now.toLocaleDateString('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric' })
    const timeStr = now.toLocaleTimeString('ru-RU', { hour: '2-digit', minute: '2-digit' })
    // items уже отфильтрованы вызывающим кодом через visibleReceiptItems
    // (см. lib/receipt-data.ts) — здесь только рендер.
    const printableItems = data.items

    return (
      <div ref={ref} className="print-receipt" style={{ fontFamily: '"Courier New", "Courier", monospace', fontSize: '13px', fontWeight: 700, width: '280px', padding: '10px', color: '#000', background: '#fff', lineHeight: 1.35 }}>
        {/* Header — название ресторана крупно (паритет с ESC/POS 1D 21 01) */}
        <div style={{ textAlign: 'center', marginBottom: '6px' }}>
          <div style={{ fontSize: '20px', fontWeight: 800, letterSpacing: '1px', textTransform: 'uppercase' }}>{data.restaurantName || 'RestOS'}</div>
          {data.restaurantAddress && (
            <div style={{ fontSize: '11px', marginTop: '2px' }}>{data.restaurantAddress}</div>
          )}
        </div>

        {/* Document title — двойная высота, как ESC/POS 1D 21 01 */}
        <div style={{ textAlign: 'center', margin: '8px 0' }}>
          <div style={{ fontSize: '18px', fontWeight: 800, letterSpacing: '0.5px' }}>
            {data.isPreCheck ? 'ПРЕДВАРИТЕЛЬНЫЙ СЧЁТ' : 'ГОСТЕВОЙ СЧЁТ'}
          </div>
        </div>

        {/* Divider */}
        <div style={{ borderTop: '1px dashed #000', margin: '6px 0' }} />

        {/* Order info */}
        <div style={{ fontSize: '12px', lineHeight: '1.55' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Чек №</span>
            <span style={{ fontWeight: 800 }}>{data.orderNumber != null ? `#${data.orderNumber}` : data.orderId.slice(0, 8).toUpperCase()}</span>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Дата</span>
            <span>{dateStr} {timeStr}</span>
          </div>
          {data.orderType === 'hall' ? (
            <>
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <span>Зал</span>
                <span>{data.zoneName || 'Зал'}</span>
              </div>
              {data.tableName && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Стол</span>
                  <span>{data.tableName}</span>
                </div>
              )}
              {data.guestsCount && data.guestsCount > 0 && (
                <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                  <span>Гостей</span>
                  <span>{data.guestsCount}</span>
                </div>
              )}
            </>
          ) : (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Тип</span>
              <span>{TYPE_LABELS[data.orderType]}</span>
            </div>
          )}
          {data.waiterName && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Официант</span>
              <span>{data.waiterName}</span>
            </div>
          )}
          {data.cashierName && (
            <div style={{ display: 'flex', justifyContent: 'space-between' }}>
              <span>Кассир</span>
              <span>{data.cashierName}</span>
            </div>
          )}
        </div>

        {/* Items header — обёрнут в HR сверху и снизу, как в ESC/POS */}
        <div style={{ borderTop: '1px dashed #000', marginTop: '8px' }} />
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '12px', fontWeight: 800, padding: '4px 0' }}>
          <span>Наименование</span>
          <span>Сумма</span>
        </div>
        <div style={{ borderBottom: '1px dashed #000', marginBottom: '6px' }} />

        {/* Items — одна строка «{name} ×{qty}    {lineTotal}», модификаторы отдельно */}
        {printableItems.map((item, i) => {
          const qtyStr = item.unit && item.unit !== 'piece' ? formatQty(item.qty, item.unit) : `×${item.qty}`
          return (
            <div key={i} style={{ marginBottom: '3px' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '13px' }}>
                <span style={{ flex: 1, marginRight: '8px', wordBreak: 'break-word' }}>
                  {item.name} <span style={{ fontWeight: 600 }}>{qtyStr}</span>
                </span>
                <span style={{ fontWeight: 800, whiteSpace: 'nowrap' }}>{formatCurrency(calcLineTotal(item.price, item.qty, item.unit, item.unitSize))}</span>
              </div>
              {item.modifiers && item.modifiers.length > 0 && (
                <div style={{ fontSize: '11px', paddingLeft: '8px' }}>
                  {item.modifiers.map((m, mi) => (
                    <div key={mi}>+ {m.name}{m.price > 0 ? ` (+${formatCurrency(m.price)})` : ''}</div>
                  ))}
                </div>
              )}
            </div>
          )
        })}

        {/* Divider */}
        <div style={{ borderTop: '1px dashed #000', margin: '8px 0' }} />

        {/* Subtotal */}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '2px' }}>
          <span>Подытог</span>
          <span>{formatCurrency(data.subtotal)}</span>
        </div>

        {/* Discount */}
        {data.discountAmount != null && data.discountAmount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '2px' }}>
            <span>Скидка{data.discountReason ? ` (${data.discountReason})` : ''}</span>
            <span>-{formatCurrency(data.discountAmount)}</span>
          </div>
        )}

        {/* Service charge */}
        {data.servicePercent > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '2px' }}>
            <span>Обслуживание ({data.servicePercent}%)</span>
            <span>{formatCurrency(data.serviceAmount)}</span>
          </div>
        )}

        {/* Tips */}
        {data.tipAmount != null && data.tipAmount > 0 && (
          <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '2px' }}>
            <span>Чаевые</span>
            <span>{formatCurrency(data.tipAmount)}</span>
          </div>
        )}

        {/* Divider */}
        <div style={{ borderTop: '2px solid #000', margin: '6px 0' }} />

        {/* Total — двойная ширина+высота, как ESC/POS 1D 21 11 */}
        <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '24px', fontWeight: 800, marginBottom: '4px', letterSpacing: '0.5px' }}>
          <span>ИТОГО</span>
          <span>{formatCurrency(data.total)}</span>
        </div>

        {/* Payment method — hidden for pre-check */}
        {!data.isPreCheck && (
          <>
            <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', marginBottom: '2px' }}>
              <span>Оплата</span>
              <span>{data.paymentMethod ? PAYMENT_LABELS[data.paymentMethod] : '—'}</span>
            </div>
            {data.accountName && (
              <div style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px' }}>
                <span>Счёт</span>
                <span>{data.accountName}</span>
              </div>
            )}
          </>
        )}

        {/* Divider */}
        <div style={{ borderTop: '1px dashed #000', margin: '10px 0' }} />

        {/* Footer — паритет с ESC/POS */}
        <div style={{ textAlign: 'center', fontSize: '11px', lineHeight: '1.5' }}>
          {data.isPreCheck ? (
            <>
              <div style={{ fontStyle: 'italic', marginBottom: '4px' }}>Не является фискальным документом</div>
              <div style={{ marginTop: '6px', fontSize: '10px' }}>Powered by RestOS</div>
            </>
          ) : (
            <>
              <div style={{ fontWeight: 800 }}>СПАСИБО! ЖДЁМ ВАС СНОВА!</div>
              <div style={{ marginTop: '6px', fontSize: '10px' }}>Powered by RestOS</div>
            </>
          )}
        </div>
      </div>
    )
  }
)
