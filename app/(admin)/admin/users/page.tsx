'use client'

import { useState, useEffect } from 'react'
import { fetchAllUsers } from '@/lib/queries'
import { formatCurrency } from '@/lib/helpers'
import { ROLE_LABELS, type User } from '@/lib/types'
import { Search, Users } from 'lucide-react'
import { Link } from 'react-router-dom'

interface UserWithRestaurant extends User {
  restaurantName?: string
}

export default function AdminUsersPage() {
  const [users, setUsers] = useState<UserWithRestaurant[]>([])
  const [loading, setLoading] = useState(true)
  const [search, setSearch] = useState('')
  const [roleFilter, setRoleFilter] = useState('all')

  useEffect(() => {
    fetchAllUsers()
      .then(setUsers)
      .finally(() => setLoading(false))
  }, [])

  const roles = ['all', ...new Set(users.map(u => u.role))]

  const filtered = users.filter(u => {
    const matchSearch = u.name.toLowerCase().includes(search.toLowerCase()) ||
      u.username.toLowerCase().includes(search.toLowerCase()) ||
      (u.restaurantName || '').toLowerCase().includes(search.toLowerCase())
    const matchRole = roleFilter === 'all' || u.role === roleFilter
    return matchSearch && matchRole
  })

  if (loading) {
    return (
      <div className="p-6 flex items-center justify-center h-64">
        <div className="size-8 border-4 border-primary/30 border-t-primary rounded-full animate-spin" />
      </div>
    )
  }

  return (
    <div className="p-6 space-y-5">
      <div>
        <h1 className="text-xl font-bold text-foreground">Все пользователи</h1>
        <p className="text-muted-foreground text-sm mt-0.5">{users.length} пользователей во всех ресторанах</p>
      </div>

      {/* Filters */}
      <div className="flex flex-col sm:flex-row gap-3">
        <div className="relative flex-1">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 size-4 text-muted-foreground" />
          <input
            value={search}
            onChange={e => setSearch(e.target.value)}
            placeholder="Поиск по имени, логину, ресторану..."
            className="w-full pl-10 pr-4 py-2.5 bg-card border border-border rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-primary/30"
          />
        </div>
        <div className="flex gap-1 bg-muted/50 p-1 rounded-lg shrink-0 overflow-x-auto">
          {roles.map(r => (
            <button
              key={r}
              onClick={() => setRoleFilter(r)}
              className={`px-3 py-1.5 text-xs font-medium rounded-md transition-colors whitespace-nowrap ${
                roleFilter === r
                  ? 'bg-background text-foreground shadow-sm'
                  : 'text-muted-foreground hover:text-foreground'
              }`}
            >
              {r === 'all' ? 'Все' : ROLE_LABELS[r as keyof typeof ROLE_LABELS] || r}
            </button>
          ))}
        </div>
      </div>

      {/* Table */}
      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[600px]">
            <thead>
              <tr className="border-b border-border bg-muted/30">
                <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground">Имя</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground">Логин</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground">Роль</th>
                <th className="text-left px-5 py-3 text-xs font-semibold text-muted-foreground">Ресторан</th>
                <th className="text-right px-5 py-3 text-xs font-semibold text-muted-foreground">Зарплата</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-border">
              {filtered.map(u => (
                <tr key={u.id} className="hover:bg-muted/20">
                  <td className="px-5 py-3">
                    <div className="flex items-center gap-2.5">
                      <div className="size-7 rounded-full bg-muted flex items-center justify-center text-[10px] font-bold text-muted-foreground">
                        {u.name.split(' ').map(n => n[0]).join('')}
                      </div>
                      <span className="text-sm font-medium text-foreground">{u.name}</span>
                    </div>
                  </td>
                  <td className="px-5 py-3 text-sm text-muted-foreground">@{u.username}</td>
                  <td className="px-5 py-3">
                    <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-primary/10 text-primary">
                      {ROLE_LABELS[u.role] || u.role}
                    </span>
                  </td>
                  <td className="px-5 py-3">
                    {u.restaurantId ? (
                      <Link to={`/admin/restaurants/${u.restaurantId}`} className="text-sm text-primary hover:underline">
                        {u.restaurantName || u.restaurantId.slice(0, 8)}
                      </Link>
                    ) : (
                      <span className="text-sm text-muted-foreground">—</span>
                    )}
                  </td>
                  <td className="px-5 py-3 text-sm text-right text-foreground">
                    {u.salary ? formatCurrency(u.salary) : '—'}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {filtered.length === 0 && (
          <div className="px-5 py-8 text-center text-muted-foreground text-sm">
            Ничего не найдено
          </div>
        )}
      </div>
    </div>
  )
}
