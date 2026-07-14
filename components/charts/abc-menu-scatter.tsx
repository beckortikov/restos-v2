'use client'

import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  ZAxis,
  CartesianGrid,
  Tooltip,
  ReferenceLine,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import { useMemo } from 'react'
import type { ABCClass } from '@/lib/types'
import { formatCurrency } from '@/lib/helpers'

const ABC_COLORS: Record<ABCClass, string> = {
  A: 'oklch(0.64 0.18 145)',
  B: 'var(--color-primary)',
  C: 'oklch(0.57 0.22 27)',
}

type ScatterItem = { x: number; y: number; z: number; name: string; abc: ABCClass }

// Медиана — те же пороги, что бэк использует для Menu Engineering (median qty /
// median margin). Рисуем их пунктиром → получаем 4 квадранта матрицы.
function median(nums: number[]): number {
  if (nums.length === 0) return 0
  const s = [...nums].sort((a, b) => a - b)
  const mid = Math.floor(s.length / 2)
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2
}

const fmtQty = (v: number) => (v % 1 === 0 ? String(v) : v.toFixed(1))

export default function AbcMenuScatter({ data }: { data: ScatterItem[] }) {
  const medX = useMemo(() => median(data.map(d => d.x)), [data])
  const medY = useMemo(() => median(data.map(d => d.y)), [data])

  return (
    <ResponsiveContainer width="100%" height={320}>
      <ScatterChart margin={{ top: 16, right: 24, bottom: 24, left: 8 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          type="number"
          dataKey="x"
          name="Продано (порций)"
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={fmtQty}
          label={{
            value: 'Продано, порций →',
            position: 'insideBottom',
            offset: -12,
            fontSize: 11,
            fill: 'var(--color-muted-foreground)',
          }}
        />
        <YAxis
          type="number"
          dataKey="y"
          name="Маржа %"
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          unit="%"
          label={{
            value: 'Маржа →',
            angle: -90,
            position: 'insideLeft',
            offset: 16,
            fontSize: 11,
            fill: 'var(--color-muted-foreground)',
          }}
        />
        {/* Размер пузыря = выручка блюда */}
        <ZAxis type="number" dataKey="z" range={[50, 620]} name="Выручка" />
        {/* Медианные оси → квадранты Boston Matrix */}
        {data.length > 1 && (
          <>
            <ReferenceLine
              x={medX}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="4 4"
              strokeOpacity={0.5}
            />
            <ReferenceLine
              y={medY}
              stroke="var(--color-muted-foreground)"
              strokeDasharray="4 4"
              strokeOpacity={0.5}
              label={{ value: `медиана ${fmtQty(medY)}%`, position: 'insideTopRight', fontSize: 10, fill: 'var(--color-muted-foreground)' }}
            />
          </>
        )}
        <Tooltip
          cursor={{ strokeDasharray: '3 3' }}
          contentStyle={{
            backgroundColor: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
          content={({ active, payload }: any) => {
            if (!active || !payload?.length) return null
            const p = payload[0]?.payload as ScatterItem | undefined
            if (!p) return null
            return (
              <div style={{ background: 'var(--color-card)', border: '1px solid var(--color-border)', borderRadius: 8, padding: '8px 10px', fontSize: 12 }}>
                <div style={{ fontWeight: 700, color: 'var(--color-foreground)', marginBottom: 4 }}>
                  {p.name} <span style={{ opacity: 0.6 }}>· {p.abc}</span>
                </div>
                <div style={{ color: 'var(--color-muted-foreground)', display: 'grid', gridTemplateColumns: 'auto auto', columnGap: 10, rowGap: 2 }}>
                  <span>Продано</span><span style={{ textAlign: 'right', color: 'var(--color-foreground)' }}>{fmtQty(p.x)} порц.</span>
                  <span>Маржа</span><span style={{ textAlign: 'right', color: 'var(--color-foreground)' }}>{p.y.toFixed(1)}%</span>
                  <span>Выручка</span><span style={{ textAlign: 'right', color: 'var(--color-foreground)' }}>{formatCurrency(p.z)}</span>
                </div>
              </div>
            )
          }}
        />
        <Scatter data={data} shape="circle">
          {data.map((entry, i) => (
            <Cell key={i} fill={ABC_COLORS[entry.abc]} fillOpacity={0.7} stroke={ABC_COLORS[entry.abc]} strokeOpacity={0.9} />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  )
}
