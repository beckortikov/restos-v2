'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'
import { formatCurrency } from '@/lib/helpers'

type ChartItem = { month: string; actual?: number; forecast?: number }

export default function RevenueForecastChart({ data }: { data: ChartItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <AreaChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
        <XAxis
          dataKey="month"
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
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
          formatter={(val: number, name: string) => [
            formatCurrency(val),
            name === 'actual' ? 'Факт' : 'Прогноз',
          ]}
        />
        <Area
          type="monotone"
          dataKey="actual"
          stroke="oklch(0.64 0.18 145)"
          fill="oklch(0.64 0.18 145 / 0.2)"
          strokeWidth={2}
        />
        <Area
          type="monotone"
          dataKey="forecast"
          stroke="var(--color-primary)"
          fill="var(--color-primary)"
          fillOpacity={0.1}
          strokeWidth={2}
          strokeDasharray="6 4"
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
