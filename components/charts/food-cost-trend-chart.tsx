'use client'

import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts'

type ChartItem = { month: string; foodCostPct: number }

export default function FoodCostTrendChart({ data }: { data: ChartItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={260}>
      <LineChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
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
          tickFormatter={(v) => `${v}%`}
          domain={[0, 'auto']}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(val: number) => [`${val.toFixed(1)}%`, 'Food Cost']}
        />
        <Line
          type="monotone"
          dataKey="foodCostPct"
          stroke="oklch(0.57 0.22 27)"
          strokeWidth={2}
          dot={{ r: 4, fill: 'oklch(0.57 0.22 27)' }}
        />
      </LineChart>
    </ResponsiveContainer>
  )
}
