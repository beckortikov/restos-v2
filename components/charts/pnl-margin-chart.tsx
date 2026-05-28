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
import { formatCurrency } from '@/lib/helpers'

type ChartItem = { name: string; margin: number }

export default function PnlMarginChart({ data }: { data: ChartItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={280}>
      <BarChart data={data} layout="vertical" margin={{ top: 0, right: 40, bottom: 0, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          unit="%"
        />
        <YAxis
          dataKey="name"
          type="category"
          tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          width={120}
        />
        <Tooltip
          contentStyle={{
            backgroundColor: 'var(--color-card)',
            border: '1px solid var(--color-border)',
            borderRadius: 8,
            fontSize: 12,
          }}
          formatter={(val: number) => [`${val}%`, 'Маржа']}
        />
        <Bar dataKey="margin" radius={[0, 4, 4, 0]}>
          {data.map((entry) => (
            <Cell
              key={entry.name}
              fill={
                entry.margin >= 65
                  ? 'oklch(0.64 0.18 145)'
                  : entry.margin >= 50
                  ? 'var(--color-primary)'
                  : 'oklch(0.57 0.22 27)'
              }
            />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
