'use client'

import { useState, useEffect } from 'react'
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from '@/components/ui/dialog'
import { formatCurrency } from '@/lib/helpers'
import { type User, type FinancialAccount } from '@/lib/types'
import { fetchFinancialAccounts } from '@/lib/queries'

interface PaySalaryDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  employee: User | null
  onSubmit: (data: { employeeId: string; amount: number; accountId: string }) => void
}

export function PaySalaryDialog({ open, onOpenChange, employee, onSubmit }: PaySalaryDialogProps) {
  const [accountId, setAccountId] = useState('')
  const [accounts, setAccounts] = useState<FinancialAccount[]>([])
  const [dataLoaded, setDataLoaded] = useState(false)

  useEffect(() => {
    if (open && !dataLoaded) {
      fetchFinancialAccounts()
        .then((a) => { setAccounts(a); setDataLoaded(true) })
    }
  }, [open, dataLoaded])

  if (!employee) return null

  const salary = employee.salary ?? 0
  const advance = employee.advance ?? 0
  const deductions = employee.deductions ?? 0
  const net = salary - advance - deductions

  function handleSubmit() {
    onSubmit({
      employeeId: employee!.id,
      amount: net,
      accountId,
    })
    onOpenChange(false)
  }

  const canSubmit = accountId && net > 0

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md rounded-xl">
        <DialogHeader>
          <DialogTitle>Выплата зарплаты</DialogTitle>
        </DialogHeader>

        <div className="space-y-4">
          {/* Employee info */}
          <div className="p-4 bg-muted/50 rounded-lg border border-border space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Сотрудник</span>
              <span className="text-sm font-medium text-foreground">{employee.name}</span>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Должность</span>
              <span className="text-sm text-foreground">{employee.roleDisplay}</span>
            </div>
            <div className="h-px bg-border" />
            <div className="flex items-center justify-between">
              <span className="text-sm text-muted-foreground">Оклад</span>
              <span className="text-sm font-medium text-foreground">{formatCurrency(salary)}</span>
            </div>
            {advance > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Аванс (выдан)</span>
                <span className="text-sm text-amber-600">- {formatCurrency(advance)}</span>
              </div>
            )}
            {deductions > 0 && (
              <div className="flex items-center justify-between">
                <span className="text-sm text-muted-foreground">Удержания</span>
                <span className="text-sm text-destructive">- {formatCurrency(deductions)}</span>
              </div>
            )}
            <div className="h-px bg-border" />
            <div className="flex items-center justify-between">
              <span className="text-sm font-medium text-foreground">К выплате</span>
              <span className="text-lg font-bold text-foreground">{formatCurrency(net)}</span>
            </div>
          </div>

          {/* Account select */}
          <div className="space-y-1.5">
            <label className="text-sm font-medium text-foreground">Счёт списания</label>
            <select
              value={accountId}
              onChange={(e) => setAccountId(e.target.value)}
              className="w-full px-3 py-2 text-sm bg-card border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-primary/30"
            >
              <option value="">Выберите счёт</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} — {formatCurrency(a.balance)}
                </option>
              ))}
            </select>
          </div>
        </div>

        <DialogFooter>
          <button
            type="button"
            onClick={() => onOpenChange(false)}
            className="px-4 py-2 text-sm font-medium text-foreground bg-card border border-border rounded-lg hover:bg-muted transition-colors"
          >
            Отмена
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!canSubmit}
            className="px-4 py-2 text-sm font-medium text-primary-foreground bg-primary rounded-lg hover:bg-primary/90 transition-colors disabled:opacity-50 disabled:pointer-events-none"
          >
            Выплатить {formatCurrency(net)}
          </button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
