'use client'

import {
  ScatterChart,
  Scatter,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import type { ABCClass } from '@/lib/types'

const ABC_COLORS: Record<ABCClass, string> = {
  A: 'oklch(0.64 0.18 145)',
  B: 'var(--color-primary)',
  C: 'oklch(0.57 0.22 27)',
}

type ScatterItem = { x: number; y: number; name: string; abc: ABCClass }

export default function AbcMenuScatter({ data }: { data: ScatterItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <ScatterChart margin={{ top: 10, right: 20, bottom: 10, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="x"
          name="Продано (порций)"
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          label={{
            value: 'Продано (порций)',
            position: 'insideBottom',
            offset: -5,
            fontSize: 11,
            fill: 'var(--color-muted-foreground)',
          }}
        />
        <YAxis
          dataKey="y"
          name="Маржа %"
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          unit="%"
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(val: number, name: string) => [
            name === 'x' ? `${val} порц.` : `${val.toFixed(1)}%`,
            name === 'x' ? 'Продано' : 'Маржа',
          ]}
          labelFormatter={(_: unknown, payload: ReadonlyArray<{ payload?: { name?: string } }>) => payload?.[0]?.payload?.name ?? ''}
        />
        <Scatter data={data} shape="circle">
          {data.map((entry, i) => (
            <Cell key={i} fill={ABC_COLORS[entry.abc]} opacity={0.85} />
          ))}
        </Scatter>
      </ScatterChart>
    </ResponsiveContainer>
  )
}
