'use client'

import { useState, useEffect } from 'react'
import { fetchAllRestaurants, fetchAllUsers } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import type { Restaurant, User } from '@/lib/types'
import { Building2, Users, ShoppingBag, TrendingUp } from 'lucide-react'
import { Link } from 'react-router-dom'

export default function AdminDashboardPage() {
  const [restaurants, setRestaurants] = useState<Restaurant[]>([])
  const [users, setUsers] = useState<User[]>([])
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    Promise.all([fetchAllRestaurants(), fetchAllUsers()])
      .then(([r, u]) => { setRestaurants(r); setUsers(u) })
      .catch(e => console.error('Admin fetch error:', e))
      .finally(() => setLoading(false))
  }, [])

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  const totalUsers = users.length
  const owners = users.filter(u => u.role === 'owner').length

  return (
    <div className="p-6 space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-foreground">Панель управления</h1>
        <p className="text-muted-foreground text-sm mt-1">Обзор всех ресторанов и пользователей</p>
      </div>

      {/* KPI cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <div className="bg-card rounded-xl border border-border p-5">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg bg-primary/10 flex items-center justify-center">
              <Building2 className="size-5 text-primary" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-medium">Рестораны</p>
              <p className="text-2xl font-bold text-foreground">{restaurants.length}</p>
            </div>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg bg-blue-500/10 flex items-center justify-center">
              <Users className="size-5 text-blue-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-medium">Пользователи</p>
              <p className="text-2xl font-bold text-foreground">{totalUsers}</p>
            </div>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg bg-emerald-500/10 flex items-center justify-center">
              <ShoppingBag className="size-5 text-emerald-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-medium">Владельцы</p>
              <p className="text-2xl font-bold text-foreground">{owners}</p>
            </div>
          </div>
        </div>
        <div className="bg-card rounded-xl border border-border p-5">
          <div className="flex items-center gap-3">
            <div className="size-10 rounded-lg bg-amber-500/10 flex items-center justify-center">
              <TrendingUp className="size-5 text-amber-500" />
            </div>
            <div>
              <p className="text-xs text-muted-foreground font-medium">Ср. персонал</p>
              <p className="text-2xl font-bold text-foreground">
                {restaurants.length > 0 ? Math.round(totalUsers / restaurants.length) : 0}
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Recent restaurants */}
      <div className="bg-card rounded-xl border border-border">
        <div className="flex items-center justify-between px-5 py-4 border-b border-border">
          <h2 className="text-sm font-semibold text-foreground">Рестораны</h2>
          <Link to="/admin/restaurants" className="text-xs text-primary hover:underline">Все →</Link>
        </div>
        <div className="divide-y divide-border">
          {restaurants.slice(0, 10).map((r) => {
            const restUsers = users.filter(u => u.restaurantId === r.id)
            const owner = restUsers.find(u => u.role === 'owner')
            return (
              <Link
                key={r.id}
                to={`/admin/restaurants/${r.id}`}
                className="flex items-center justify-between px-5 py-3.5 hover:bg-muted/30 transition-colors"
              >
                <div className="flex items-center gap-3">
                  <div className="size-9 rounded-lg bg-primary/10 flex items-center justify-center text-sm font-bold text-primary">
                    {r.name[0]}
                  </div>
                  <div>
                    <p className="text-sm font-medium text-foreground">{r.name}</p>
                    <p className="text-xs text-muted-foreground">{r.slug} · {r.address || 'Без адреса'}</p>
                  </div>
                </div>
                <div className="text-right">
                  <p className="text-sm font-medium text-foreground">{restUsers.length} чел.</p>
                  <p className="text-xs text-muted-foreground">{owner?.name || 'Нет владельца'}</p>
                </div>
              </Link>
            )
          })}
          {restaurants.length === 0 && (
            <div className="px-5 py-8 text-center text-muted-foreground text-sm">
              Нет ресторанов. Создайте первый.
            </div>
          )}
        </div>
      </div>
    </div>
  )
}
