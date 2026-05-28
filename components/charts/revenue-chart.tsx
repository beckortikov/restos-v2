'use client'

import { useState, useEffect } from 'react'
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
import { fetchMonthlyRevenue } from '@/lib/queries'

export default function RevenueChart() {
  const [data, setData] = useState<{ month: string; revenue: number; expenses: number; profit: number }[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    fetchMonthlyRevenue()
      .then(setData)
      .finally(() => setLoading(false))
  }, [])

  if (loading) return <div className="h-[220px] bg-muted/30 rounded-lg animate-pulse" />

  return (
    <ResponsiveContainer width="100%" height={220}>
      <AreaChart data={data} margin={{ top: 5, right: 5, bottom: 0, left: 10 }}>
        <defs>
          <linearGradient id="gRev" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="var(--color-primary)" stopOpacity={0.15} />
            <stop offset="95%" stopColor="var(--color-primary)" stopOpacity={0} />
          </linearGradient>
          <linearGradient id="gPro" x1="0" y1="0" x2="0" y2="1">
            <stop offset="5%" stopColor="#10b981" stopOpacity={0.15} />
            <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
          </linearGradient>
        </defs>
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
          formatter={(val: number) => [formatCurrency(val), '']}
        />
        <Area
          type="monotone"
          dataKey="revenue"
          name="Выручка"
          stroke="var(--color-primary)"
          fill="url(#gRev)"
          strokeWidth={2}
          dot={false}
        />
        <Area
          type="monotone"
          dataKey="profit"
          name="Прибыль"
          stroke="#10b981"
          fill="url(#gPro)"
          strokeWidth={2}
          dot={false}
        />
      </AreaChart>
    </ResponsiveContainer>
  )
}
