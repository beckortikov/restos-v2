'use client'

import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  ReferenceLine,
  Legend,
} from 'recharts'
import { formatCurrency } from '@/lib/helpers'

type ChartItem = { month: string; fixed: number; variable: number; revenue: number }

export default function BreakevenChart({
  data,
  breakevenLine,
}: {
  data: ChartItem[]
  breakevenLine: number
}) {
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
          formatter={(val: number, name: string) => {
            const labels: Record<string, string> = {
              fixed: 'Постоянные',
              variable: 'Переменные',
              revenue: 'Выручка',
            }
            return [formatCurrency(val), labels[name] ?? name]
          }}
        />
        <Legend
          formatter={(value: string) => {
            const labels: Record<string, string> = {
              fixed: 'Постоянные',
              variable: 'Переменные',
              revenue: 'Выручка',
            }
            return labels[value] ?? value
          }}
          wrapperStyle={{ fontSize: 12 }}
        />
        <Area
          type="monotone"
          dataKey="fixed"
          stackId="costs"
          stroke="oklch(0.57 0.22 27)"
          fill="oklch(0.57 0.22 27 / 0.3)"
          strokeWidth={1.5}
        />
        <Area
          type="monotone"
          dataKey="variable"
          stackId="costs"
          stroke="oklch(0.75 0.15 85)"
          fill="oklch(0.75 0.15 85 / 0.3)"
          strokeWidth={1.5}
        />
        <Area
          type="monotone"
          dataKey="revenue"
          stroke="oklch(0.64 0.18 145)"
          fill="oklch(0.64 0.18 145 / 0.15)"
          strokeWidth={2}
        />
        <ReferenceLine
          y={breakevenLine}
          stroke="oklch(0.57 0.22 27)"
          strokeDasharray="6 4"
          strokeWidth={2}
          label={{
            value: 'Безубыточность',
            position: 'insideTopRight',
            fontSize: 11,
            fill: 'oklch(0.57 0.22 27)',
          }}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
