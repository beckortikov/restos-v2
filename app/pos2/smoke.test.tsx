import { describe, it, expect, vi, afterEach } from 'vitest'
import { render, cleanup, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'

// Смоук-тесты: каждый экран /pos2 монтируется и рендерит интерактивный UI без
// падения. Ловят регрессии класса «раздел не открывается» — битый импорт,
// неверный порядок хуков, undefined-деструктуризация, ошибка в JSX. Тонкую
// денежную/сплит-логику проверяют юнит-тесты в lib/pos-v2/*.

const TABLE = {
  id: 't1', number: 1, name: 'Стол 1', capacity: 4, zone: 'z1',
  status: 'occupied', currentOrderId: 'o1', currentOrderIds: ['o1'],
}
const ORDER = {
  id: 'o1', number: 1, type: 'hall', status: 'cooking', total: 100, subtotal: 100,
  tableId: 't1', guestsCount: 2,
  items: [{ id: 'i1', menuItemId: 'm1', name: 'Плов', qty: 1, price: 100, cogs: 30, unit: 'piece', unitSize: 1 }],
}

vi.mock('@/lib/auth-store', () => ({
  useAuth: () => ({
    user: { id: 'u1', name: 'Кассир', role: 'cashier' },
    restaurant: { id: 'r1', name: 'Тест-Ресторан', servicePercent: 10 },
    restaurantId: 'r1',
    loading: false,
    canDo: () => true,
    canAccessRoles: () => true,
    hasAccess: () => true,
    logout: vi.fn(),
  }),
}))

vi.mock('@/components/order/use-order-data', () => ({
  useOrderData: () => ({
    menuItems: [], categories: [], tables: [TABLE],
    zones: [{ id: 'z1', name: 'Зал' }], loading: false, reload: vi.fn(),
  }),
}))

vi.mock('sonner', () => ({
  toast: Object.assign(vi.fn(), { success: vi.fn(), error: vi.fn(), info: vi.fn() }),
}))

// xlsx тянется на верхнем уровне shift-export — мокаем, чтобы не грузить его.
vi.mock('@/lib/shift-export', () => ({ exportShiftToXlsx: vi.fn() }))

// Мок всего слоя queries: список-фетчеры → [], спец-фетчеры → нужную форму
// (иначе .map/.filter на undefined уронит рендер), мутации → resolve.
vi.mock('@/lib/queries', () => {
  const list = () => Promise.resolve([])
  const ok = () => Promise.resolve({})
  return {
    __esModule: true,
    // fetchers
    fetchActiveShift: () => Promise.resolve(null),
    fetchShiftRevenue: () => Promise.resolve({ cashRevenue: 0, cardRevenue: 0, ordersCount: 0, avgCheck: 0 }),
    fetchShiftOperations: list,
    fetchShiftZReport: () => Promise.resolve(null),
    fetchShifts: list,
    fetchReservationForTable: () => Promise.resolve(null),
    fetchServiceAccrualByShift: list,
    fetchServicePayoutByShift: ok,
    fetchUsers: list,
    fetchTables: () => Promise.resolve([TABLE]),
    fetchOrders: () => Promise.resolve([ORDER]),
    fetchOrderSplits: list,
    fetchFinancialAccounts: list,
    // stop-list / showcase / batch / prints
    fetchStopList: list,
    fetchMenuItems: list,
    fetchIngredients: list,
    fetchSemiStock: list,
    fetchWriteoffs: list,
    fetchBatchAvailability: () => Promise.resolve(new Map()),
    fetchBatchCookingLogs: list,
    fetchPrintJobs: list,
    toggleStopListOverride: ok,
    toggleMenuAvailability: ok,
    createWriteoff: ok,
    calculateMaxPortions: () => Promise.resolve({ maxPortions: 0, hasRecipe: false, ingredients: [] }),
    produceBatch: ok,
    writeoffPreparedBatch: ok,
    cancelOrderItemPartial: () => Promise.resolve({ orderId: 'o1', allCancelled: false, newTotal: 0 }),
    assignWaiter: ok,
    // mutations / actions
    createOrder: () => Promise.resolve(ORDER),
    closeOrderWithPayment: ok, openTableForOrder: ok, addItemsToOrder: ok, printPreBill: ok,
    cancelOrder: ok, cancelOrderItem: ok, transferOrder: ok, setOrderItemNote: ok,
    splitOrderEqual: ok, splitOrderByItems: ok, paySplit: ok, cancelSplits: ok,
    refundOrder: ok, reprintOrderReceipt: ok, reopenOrder: ok,
    createReservation: ok, updateReservationStatus: ok, mergeTables: ok, unmergeTables: ok,
    createTable: ok, updateTableData: ok, deleteTable: ok, createZone: ok, updateZone: ok, deleteZone: ok,
    payServiceCharge: ok,
    openShift: ok, closeShift: ok, addShiftOperation: ok, createShiftExpense: ok,
    printShiftX: ok, printShiftZ: ok, printShiftService: ok,
  }
})

import Launcher from './page'
import OrderPage from './order/page'
import PayPage from './pay/page'
import TicketPage from './ticket/page'
import HistoryPage from './history/page'
import TablesPage from './tables/page'
import ServicePage from './service/page'
import ShiftPage from './shift/page'
import SettingsPage from './settings/page'
import StopPage from './stop/page'
import OrdersPage from './orders/page'
import ShowcasePage from './showcase/page'
import BatchPage from './batch/page'

const PAGES: [string, React.ComponentType, string][] = [
  ['лаунчер', Launcher, '/pos2'],
  ['новый заказ', OrderPage, '/pos2/order'],
  ['оплата', PayPage, '/pos2/pay'],
  ['тикет заказа', TicketPage, '/pos2/ticket?order=o1'],
  ['история', HistoryPage, '/pos2/history'],
  ['карта зала', TablesPage, '/pos2/tables'],
  ['обслуживание', ServicePage, '/pos2/service'],
  ['смена', ShiftPage, '/pos2/shift'],
  ['настройки', SettingsPage, '/pos2/settings'],
  ['стоп-лист', StopPage, '/pos2/stop'],
  ['активные заказы', OrdersPage, '/pos2/orders'],
  ['витрина', ShowcasePage, '/pos2/showcase'],
  ['заготовки', BatchPage, '/pos2/batch'],
]

afterEach(cleanup)

describe('/pos2 экраны монтируются без падения', () => {
  for (const [name, Page, path] of PAGES) {
    it(`«${name}» рендерится и показывает интерактивный UI`, async () => {
      render(
        <MemoryRouter initialEntries={[path]}>
          <Page />
        </MemoryRouter>,
      )
      const buttons = await screen.findAllByRole('button', undefined, { timeout: 3000 })
      expect(buttons.length).toBeGreaterThan(0)
    })
  }
})
