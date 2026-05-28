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

type ChartItem = { name: string; value: number }

export default function IngredientStockChart({ data }: { data: ChartItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 5, right: 20, bottom: 50, left: 10 }}>
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
          formatter={(val: number) => [formatCurrency(val), 'Стоимость запасов']}
        />
        <Bar dataKey="value" radius={[4, 4, 0, 0]} fill="var(--color-primary)" />
      </BarChart>
    </ResponsiveContainer>
  )
}
