'use client'

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/helpers'
import { type FinancialActivity } from '@/lib/types'

type ChartItem = { label: string; in: number; out: number }

export default function CashflowChart({ data }: { data: ChartItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={200}>
      <BarChart data={data} margin={{ top: 5, right: 5, bottom: 40, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="label"
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
          formatter={(val: number) => [formatCurrency(val), '']}
        />
        <Bar dataKey="out" name="Расход" fill="var(--color-destructive)" radius={[4, 4, 0, 0]} opacity={0.8} />
        <Bar dataKey="in" name="Приход" fill="oklch(0.64 0.18 145)" radius={[4, 4, 0, 0]} opacity={0.8} />
      </BarChart>
    </ResponsiveContainer>
  )
}
