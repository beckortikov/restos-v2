import { api, unwrap } from './_client'
import type { User } from '../types'
import { ROLE_LABELS } from '../types'
import { logAction } from './audit'
import { mapUserRow } from './_mappers'

export async function fetchAllUsers(): Promise<(User & { restaurantName?: string })[]> {
  const [usersRes, restRes] = await Promise.all([
    unwrap(api.GET('/api/v1/users', { params: { query: { limit: 1000 } } })),
    unwrap(api.GET('/api/v1/restaurants')),
  ]) as [any, any]
  const userRows: any[] = Array.isArray(usersRes?.data) ? usersRes.data : (Array.isArray(usersRes) ? usersRes : [])
  const restRows: any[] = Array.isArray(restRes?.data) ? restRes.data : (Array.isArray(restRes) ? restRes : [])
  const restMap: Record<string, string> = {}
  for (const r of restRows) restMap[r.id] = r.name
  return userRows.map(r => ({
    ...mapUserRow(r),
    restaurantName: r.restaurant_id ? (restMap[r.restaurant_id] || '') : '',
  }))
}

export async function fetchUsersByRestaurant(restaurantId: string): Promise<User[]> {
  const res: any = await unwrap(api.GET('/api/v1/users', { params: { query: { limit: 1000, restaurant_id: restaurantId } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
  return rows.map(mapUserRow)
}

export async function createUserForRestaurant(data: {
  username: string
  name: string
  role: string
  restaurantId: string
  salary?: number
  password?: string
  pin?: string
  position?: string
  birthDate?: string
  station?: string
  shiftNumber?: number
}): Promise<User> {
  const body: Record<string, unknown> = {
    username: data.username,
    name: data.name,
    role: data.role,
    password: data.password || '1234',
  }
  if (data.pin) body.pin = data.pin
  if (data.salary != null) body.salary = String(data.salary)
  if (data.position) body.position = data.position
  if (data.birthDate) body.birth_date = data.birthDate
  if (data.station) body.station = data.station
  if (data.shiftNumber != null) body.shift_number = data.shiftNumber
  const row: any = await unwrap(api.POST('/api/v1/users', { body: body as any }))
  logAction('user.create', 'user', row?.id, data.name)
  return mapUserRow(row)
}

export async function deleteUser(userId: string): Promise<void> {
  await unwrap(api.DELETE('/api/v1/users/{id}', { params: { path: { id: userId } } }))
  logAction('user.delete', 'user', userId)
}

export async function updateUser(userId: string, data: Partial<{
  name: string; username: string; role: string; salary: number; password: string;
  position: string; birth_date: string; station: string; shift_number: number;
  advance: number; deductions: number; pin: string;
}>) {
  const body: Record<string, unknown> = {}
  if (data.name !== undefined) body.name = data.name
  if (data.username !== undefined) body.username = data.username
  if (data.role !== undefined) body.role = data.role
  if (data.password !== undefined) body.password = data.password
  if (data.pin !== undefined) body.pin = data.pin
  if (data.position !== undefined) body.position = data.position
  if (data.birth_date !== undefined) body.birth_date = data.birth_date
  if (data.station !== undefined) body.station = data.station
  if (data.salary !== undefined) body.salary = String(data.salary)
  if (data.advance !== undefined) body.advance = String(data.advance)
  if (data.deductions !== undefined) body.deductions = String(data.deductions)
  if (data.shift_number !== undefined) body.shift_number = data.shift_number
  if (Object.keys(body).length > 0) {
    await unwrap(api.PATCH('/api/v1/users/{id}', { params: { path: { id: userId } }, body: body as any }))
  }
  logAction('user.edit', 'user', userId)
}

export async function updateUserPermissions(userId: string, permissions: import('../types').UserPermissions) {
  const data = await unwrap(api.PATCH('/api/v1/users/{id}', { params: { path: { id: userId } }, body: { permissions } as any }))
  logAction('user.permissions', 'user', userId)
  return data
}

export async function fetchUsers(): Promise<User[]> {
  const res: any = await unwrap(api.GET('/api/v1/users', { params: { query: { limit: 1000 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
  return rows.map(mapUserRow)
}

export async function fetchUserByUsername(username: string): Promise<User | null> {
  const res: any = await unwrap(api.GET('/api/v1/users', { params: { query: { limit: 1000 } } }))
  const rows: any[] = Array.isArray(res?.data) ? res.data : (Array.isArray(res) ? res : [])
  const found = rows.find(r => r.username === username)
  if (!found) return null
  return mapUserRow(found)
}

export async function generateUniquePin(restaurantId: string): Promise<string> {
  // Сервер выбирает уникальный PIN внутри ресторана — клиент его не видит до save.
  const res: any = await unwrap(api.POST('/api/v1/users/generate-pin', {
    body: { restaurant_id: restaurantId || undefined } as any,
  }))
  const pin = (res?.pin as string | undefined) || ''
  if (!pin || pin.length !== 4) {
    throw new Error('Не удалось сгенерировать уникальный PIN — слишком много сотрудников')
  }
  return pin
}

export async function validatePin(pin: string, restaurantId: string): Promise<User | null> {
  try {
    const data: any = await unwrap(api.POST('/api/v1/users/validate-pin', {
      body: { pin, restaurant_id: restaurantId || undefined } as any,
    }))
    if (!data || !data.id) return null
    return {
      id: data.id,
      username: data.username ?? '',
      name: data.name ?? '',
      role: data.role,
      roleDisplay: ROLE_LABELS[data.role as keyof typeof ROLE_LABELS] ?? data.role,
      restaurantId: data.restaurant_id || '',
      salary: Number(data.salary) || 0,
      // PIN не возвращается с бэка (json:"-") — клиент его не получает.
      permissions: data.permissions && typeof data.permissions === 'object' ? data.permissions as import('../types').UserPermissions : undefined,
    } as User
  } catch {
    return null
  }
}
