import { useAuth } from '@/lib/auth-store'

// Единый источник правды для ключа — читают branch-selector.tsx (пишет) и
// любой код, которому нужно программно включить/снять просмотр филиала
// (напр. drill-down из «Сводки по сети»).
export const BRANCH_VIEW_KEY = 'restos-branch-view'

// useBranchView — «сейчас смотрим отчёты как другой филиал сети» (ADR-003 Ф4,
// UX-финализация Ф7). Ключ в localStorage ставит BranchSelector
// (components/branch-selector.tsx) и сам же снимает при выборе «мой» —
// присутствие ключа само по себе значит «не мой узел», сверка с restaurantId
// нужна только на случай гонки до первого reload. Значение меняется только
// через window.location.reload() (см. branch-selector.tsx), поэтому
// достаточно синхронного чтения без подписки на storage-события.
export function useBranchView(): boolean {
  const { restaurantId } = useAuth()
  if (typeof window === 'undefined') return false
  const stored = window.localStorage.getItem(BRANCH_VIEW_KEY)
  return !!stored && stored !== restaurantId
}
