'use client'

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
} from 'recharts'
import { formatCurrency } from '@/lib/helpers'

type ChartItem = { month: string; plan: number; fact: number }

export default function PlanVsFactChart({ data }: { data: ChartItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={300}>
      <BarChart data={data} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
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
            name === 'plan' ? 'План' : 'Факт',
          ]}
        />
        <Legend
          formatter={(value: string) => (value === 'plan' ? 'План' : 'Факт')}
          wrapperStyle={{ fontSize: 12 }}
        />
        <Bar dataKey="plan" fill="var(--color-primary)" opacity={0.4} radius={[4, 4, 0, 0]} />
        <Bar dataKey="fact" fill="oklch(0.64 0.18 145)" radius={[4, 4, 0, 0]} />
      </BarChart>
    </ResponsiveContainer>
  )
}
