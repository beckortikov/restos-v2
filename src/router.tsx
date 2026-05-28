import { Routes, Route, Navigate } from 'react-router-dom'
import { lazy, Suspense } from 'react'
import { AppLayout } from './layouts/AppLayout'
import { AuthLayout } from './layouts/AuthLayout'
import { AdminLayout } from './layouts/AdminLayout'

// Suspense fallback is intentionally empty — pages render their own skeletons
// once they mount. A spinner here would flash briefly before the skeleton.
function L(factory: () => Promise<{ default: React.ComponentType }>) {
  const Component = lazy(factory)
  return (
    <Suspense fallback={null}>
      <Component />
    </Suspense>
  )
}

// Auth & Connect
const Login = () => L(() => import('@/app/(auth)/login/page'))
const Bootstrap = () => L(() => import('@/app/(auth)/bootstrap/page'))
const Connect = () => L(() => import('@/app/connect/page'))

// Dashboard
const Dashboard = () => L(() => import('@/app/(app)/dashboard/page'))

// Waiter (dedicated UI for role=waiter)
const WaiterTables = () => L(() => import('@/app/(app)/waiter/tables/page'))
const WaiterOrders = () => L(() => import('@/app/(app)/waiter/orders/page'))
const WaiterOrderNew = () => L(() => import('@/app/(app)/waiter/order/new/page'))
const WaiterOrderDetail = () => L(() => import('@/app/(app)/waiter/order/[id]/page'))

// Cashier
const CashierSettings = () => L(() => import('@/app/(app)/cashier/settings/page'))

// Operations
const POS = () => L(() => import('@/app/(app)/operations/pos/page'))
const TableMap = () => L(() => import('@/app/(app)/operations/table-map/page'))
const Orders = () => L(() => import('@/app/(app)/operations/orders/page'))
const Kitchen = () => L(() => import('@/app/(app)/operations/kitchen/page'))
const BatchCooking = () => L(() => import('@/app/(app)/operations/batch-cooking/page'))
const Shifts = () => L(() => import('@/app/(app)/operations/shifts/page'))
const Showcase = () => L(() => import('@/app/(app)/operations/showcase/page'))

// Warehouse
const Inventory = () => L(() => import('@/app/(app)/warehouse/inventory/page'))
const Menu = () => L(() => import('@/app/(app)/warehouse/menu/page'))
const Receipts = () => L(() => import('@/app/(app)/warehouse/receipts/page'))
const ReceiptsNew = () => L(() => import('@/app/(app)/warehouse/receipts/new/page'))
const Semi = () => L(() => import('@/app/(app)/warehouse/semi/page'))
const Suppliers = () => L(() => import('@/app/(app)/warehouse/suppliers/page'))
const Writeoffs = () => L(() => import('@/app/(app)/warehouse/writeoffs/page'))
const SupplyExpenses = () => L(() => import('@/app/(app)/warehouse/supply-expenses/page'))
const History = () => L(() => import('@/app/(app)/warehouse/history/page'))
const InventoryCheck = () => L(() => import('@/app/(app)/warehouse/inventory-check/page'))

// Finance
const Cashflow = () => L(() => import('@/app/(app)/finance/cashflow/page'))
const PnL = () => L(() => import('@/app/(app)/finance/pnl/page'))
const Balance = () => L(() => import('@/app/(app)/finance/balance/page'))
const Budget = () => L(() => import('@/app/(app)/finance/budget/page'))
const Accounts = () => L(() => import('@/app/(app)/finance/accounts/page'))
const Payroll = () => L(() => import('@/app/(app)/finance/payroll/page'))
const ServiceReport = () => L(() => import('@/app/(app)/finance/service-report/page'))

// Analytics
const AbcMenu = () => L(() => import('@/app/(app)/analytics/abc-menu/page'))
const AbcInventory = () => L(() => import('@/app/(app)/analytics/abc-inventory/page'))
const Tables = () => L(() => import('@/app/(app)/analytics/tables/page'))
const Waiters = () => L(() => import('@/app/(app)/analytics/waiters/page'))
const FoodCost = () => L(() => import('@/app/(app)/analytics/food-cost/page'))
const PeakHours = () => L(() => import('@/app/(app)/analytics/peak-hours/page'))
const Forecast = () => L(() => import('@/app/(app)/analytics/forecast/page'))

// Settings
const Settings = () => L(() => import('@/app/(app)/settings/page'))
const Users = () => L(() => import('@/app/(app)/settings/users/page'))
const Printers = () => L(() => import('@/app/(app)/settings/printers/page'))
const PrintersQueue = () => L(() => import('@/app/(app)/settings/printers/queue/page'))
const Import = () => L(() => import('@/app/(app)/settings/import/page'))
const Customers = () => L(() => import('@/app/(app)/settings/customers/page'))
const Audit = () => L(() => import('@/app/(app)/settings/audit/page'))

// Admin
const AdminDashboard = () => L(() => import('@/app/(admin)/admin/page'))
const AdminRestaurants = () => L(() => import('@/app/(admin)/admin/restaurants/page'))
const AdminRestaurantDetail = () => L(() => import('@/app/(admin)/admin/restaurants/[id]/page'))
const AdminUsers = () => L(() => import('@/app/(admin)/admin/users/page'))

export function AppRouter() {
  return (
    <Routes>
      {/* Корень — сразу на login (landing/pricing/oferta удалены из POS-сборки). */}
      <Route path="/" element={<Navigate to="/login" replace />} />
      <Route path="/connect" element={<Connect />} />

      {/* Auth */}
      <Route element={<AuthLayout />}>
        <Route path="/login" element={<Login />} />
        <Route path="/bootstrap" element={<Bootstrap />} />
      </Route>

      {/* Main app — protected */}
      <Route element={<AppLayout />}>
        <Route path="/dashboard" element={<Dashboard />} />

        {/* Waiter app */}
        <Route path="/waiter" element={<Navigate to="/waiter/tables" replace />} />
        <Route path="/waiter/tables" element={<WaiterTables />} />
        <Route path="/waiter/orders" element={<WaiterOrders />} />
        <Route path="/waiter/order/new" element={<WaiterOrderNew />} />
        <Route path="/waiter/order/:id" element={<WaiterOrderDetail />} />

        {/* Cashier */}
        <Route path="/cashier" element={<Navigate to="/cashier/settings" replace />} />
        <Route path="/cashier/settings" element={<CashierSettings />} />

        {/* Operations */}
        <Route path="/operations/pos" element={<POS />} />
        <Route path="/operations/table-map" element={<TableMap />} />
        <Route path="/operations/orders" element={<Orders />} />
        <Route path="/operations/kitchen" element={<Kitchen />} />
        <Route path="/operations/batch-cooking" element={<BatchCooking />} />
        <Route path="/operations/shifts" element={<Shifts />} />
        <Route path="/operations/showcase" element={<Showcase />} />

        {/* Warehouse */}
        <Route path="/warehouse/inventory" element={<Inventory />} />
        <Route path="/warehouse/menu" element={<Menu />} />
        <Route path="/warehouse/receipts" element={<Receipts />} />
        <Route path="/warehouse/receipts/new" element={<ReceiptsNew />} />
        <Route path="/warehouse/semi" element={<Semi />} />
        <Route path="/warehouse/suppliers" element={<Suppliers />} />
        <Route path="/warehouse/writeoffs" element={<Writeoffs />} />
        <Route path="/warehouse/supply-expenses" element={<SupplyExpenses />} />
        <Route path="/warehouse/history" element={<History />} />
        <Route path="/warehouse/inventory-check" element={<InventoryCheck />} />

        {/* Finance */}
        <Route path="/finance/cashflow" element={<Cashflow />} />
        <Route path="/finance/pnl" element={<PnL />} />
        <Route path="/finance/balance" element={<Balance />} />
        <Route path="/finance/budget" element={<Budget />} />
        <Route path="/finance/accounts" element={<Accounts />} />
        <Route path="/finance/payroll" element={<Payroll />} />
        <Route path="/finance/service-report" element={<ServiceReport />} />

        {/* Analytics */}
        <Route path="/analytics/abc-menu" element={<AbcMenu />} />
        <Route path="/analytics/abc-inventory" element={<AbcInventory />} />
        <Route path="/analytics/tables" element={<Tables />} />
        <Route path="/analytics/waiters" element={<Waiters />} />
        <Route path="/analytics/food-cost" element={<FoodCost />} />
        <Route path="/analytics/peak-hours" element={<PeakHours />} />
        <Route path="/analytics/forecast" element={<Forecast />} />

        {/* Settings */}
        <Route path="/settings" element={<Settings />} />
        <Route path="/settings/users" element={<Users />} />
        <Route path="/settings/printers" element={<Printers />} />
        <Route path="/settings/printers/queue" element={<PrintersQueue />} />
        <Route path="/settings/import" element={<Import />} />
        <Route path="/settings/customers" element={<Customers />} />
        <Route path="/settings/audit" element={<Audit />} />
      </Route>

      {/* Admin — superadmin only */}
      <Route element={<AdminLayout />}>
        <Route path="/admin" element={<AdminDashboard />} />
        <Route path="/admin/restaurants" element={<AdminRestaurants />} />
        <Route path="/admin/restaurants/:id" element={<AdminRestaurantDetail />} />
        <Route path="/admin/users" element={<AdminUsers />} />
      </Route>

      {/* 404 */}
      <Route path="*" element={<Navigate to="/dashboard" replace />} />
    </Routes>
  )
}
