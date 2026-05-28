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

type ChartItem = { name: string; foodCostPct: number; price: number; cogs: number }

function getBarColor(pct: number) {
  if (pct > 40) return 'oklch(0.57 0.22 27)'
  if (pct > 30) return 'oklch(0.75 0.15 85)'
  return 'oklch(0.64 0.18 145)'
}

export default function FoodCostBarChart({ data }: { data: ChartItem[] }) {
  return (
    <ResponsiveContainer width="100%" height={Math.max(300, data.length * 36)}>
      <BarChart data={data} layout="vertical" margin={{ top: 5, right: 30, bottom: 5, left: 10 }}>
        <CartesianGrid strokeDasharray="3 3" stroke="var(--color-border)" horizontal={false} />
        <XAxis
          type="number"
          tick={{ fontSize: 10, fill: 'var(--color-muted-foreground)' }}
          axisLine={false}
          tickLine={false}
          tickFormatter={(v) => `${v}%`}
          domain={[0, 'auto']}
        />
        <YAxis
          type="category"
          dataKey="name"
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
          formatter={(val: number, _name, props) => {
            const item = (props as { payload?: ChartItem }).payload
            if (!item) return [`${val.toFixed(1)}%`, 'Food Cost']
            return [`${val.toFixed(1)}% (Цена: ${item.price} / COGS: ${item.cogs})`, 'Food Cost']
          }}
        />
        <Bar dataKey="foodCostPct" radius={[0, 4, 4, 0]}>
          {data.map((entry, i) => (
            <Cell key={i} fill={getBarColor(entry.foodCostPct)} />
          ))}
        </Bar>
      </BarChart>
    </ResponsiveContainer>
  )
}
