'use client'

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Cell,
} from 'recharts'
import type { ABCClass } from '@/lib/types'
import { formatCurrency } from '@/lib/helpers'

const ABC_COLORS: Record<ABCClass, string> = {
  A: 'oklch(0.64 0.18 145)',
  B: 'var(--color-primary)',
  C: 'oklch(0.57 0.22 27)',
}

type ChartItem = { name: string; value: number; abc: ABCClass }

export default function AbcInventoryChart({ data }: { data: ChartItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={220}>
      <BarChart data={data} margin={{ top: 5, right: 5, bottom: 50, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="name"
          tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
          angle={-35}
          textAnchor="end"
          axisLine={false}
          tickLine={false}
        />
        <YAxis
          tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => `${(v / 1000).toFixed(0)}K`}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(val: number) => [formatCurrency(val), 'Стоимость']}
        />
        <Bar dataKey="value" radius={[4, 4, 0, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={ABC_COLORS[entry.abc]} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
