'use client'

import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  PieChart,
  Pie,
  Cell,
} from 'recharts'
import { formatCurrency } from '@/lib/helpers'

const STATUS_COLORS = {
  free: 'oklch(0.64 0.18 145)',
  occupied: 'oklch(0.57 0.22 27)',
  reserved: 'oklch(0.55 0.18 240)',
  bill_requested: 'oklch(0.75 0.18 80)',
}

type BarItem = { name: string; revenue: number }
type PieItem = { name: string; value: number; status: string }

export default function TablesCharts({
  barData,
  pieData,
}: {
  barData: BarItem[]
  pieData: PieItem[]
}) {
  return (
    <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
      {/* Revenue bar chart */}
      <div className="xl:col-span-2 bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Выручка по столам (TJS)</h2>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={barData} margin={{ top: 5, right: 5, bottom: 5, left: 10 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" />
            <XAxis
              dataKey="name"
              tick={{ fontSize: 11, fill: 'var(--color-muted-foreground)' }}
              axisLine={false}
              tickLine={false}
            />
            <YAxis
              tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
              axisLine={false}
              tickLine={false}
            />
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--color-card)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                fontSize: 12,
              }}
              formatter={(val: number) => [formatCurrency(val), 'Выручка']}
            />
            <Bar dataKey="revenue" fill="var(--color-primary)" radius={[4, 4, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Status pie */}
      <div className="bg-card rounded-xl border border-border p-5">
        <h2 className="text-sm font-semibold text-foreground mb-4">Статус столов</h2>
        <ResponsiveContainer width="100%" height={150}>
          <PieChart>
            <Pie
              data={pieData}
              cx="50%"
              cy="50%"
              outerRadius={65}
              dataKey="value"
              label={({ name, value }) => `${name}: ${value}`}
              labelLine={false}
              fontSize={10}
            >
              {pieData.map((entry) => (
                <Cell
                  key={entry.status}
                  fill={STATUS_COLORS[entry.status as keyof typeof STATUS_COLORS]}
                />
              ))}
            </Pie>
            <Tooltip
              contentStyle={{
                backgroundColor: 'var(--color-card)',
                border: '1px solid var(--color-border)',
                borderRadius: 8,
                fontSize: 12,
              }}
            />
          </PieChart>
        </ResponsiveContainer>
        <div className="space-y-1.5 mt-3">
          {pieData.map((s) => (
            <div key={s.status} className="flex items-center justify-between text-xs">
              <span className="flex items-center gap-1.5">
                <span
                  className="size-2.5 rounded-full inline-block"
                  style={{
                    backgroundColor: STATUS_COLORS[s.status as keyof typeof STATUS_COLORS],
                  }}
                />
                <span className="text-muted-foreground">{s.name}</span>
              </span>
              <span className="font-medium text-foreground">{s.value}</span>
            </div>
          ))}
        </div>
      </div>
    </div>
  )
}
