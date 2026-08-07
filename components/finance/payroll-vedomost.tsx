'use client'

// Ведомость на выплату зарплаты (#3) — печатная форма «под роспись» за период:
// начислено / аванс / удержания / к выплате + пустая колонка «Подпись» и
// подписи «Составил / Выдал». Печать — через изолированный iframe (никакого
// хрома приложения на листе), выгрузка — в Excel тем же exportToExcel, что и
// остальные отчёты.

import { Printer, Download, FileText } from 'lucide-react'
import { formatCurrency } from '@/lib/helpers'
import { exportToExcel } from '@/lib/export-excel'

export type VedomostRow = {
  id: string
  name: string
  position: string
  accrued: number
  advance: number
  deductions: number
  toPay: number
}

const RU = (n: number) => Math.round(n).toLocaleString('ru-RU')

function escapeHtml(s: string): string {
  return s.replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c] || c))
}

// printHTML — печатаем изолированный документ в скрытом iframe: на лист не
// попадает ни сайдбар, ни шапка приложения, а всплывающие окна (Electron их
// может блокировать) не нужны.
function printHTML(html: string) {
  const iframe = document.createElement('iframe')
  iframe.setAttribute('aria-hidden', 'true')
  iframe.style.cssText = 'position:fixed;right:0;bottom:0;width:0;height:0;border:0;'
  document.body.appendChild(iframe)
  const doc = iframe.contentWindow?.document
  if (!doc) { document.body.removeChild(iframe); return }
  doc.open(); doc.write(html); doc.close()
  const w = iframe.contentWindow!
  w.focus()
  // Даём вёрстке отрисоваться перед вызовом печати, затем убираем iframe.
  setTimeout(() => {
    w.print()
    setTimeout(() => { try { document.body.removeChild(iframe) } catch { /* уже удалён */ } }, 1000)
  }, 300)
}

function buildPrintHTML(periodLabel: string, rows: VedomostRow[], t: VedomostRow): string {
  const body = rows.map((r, i) => `<tr>
    <td class="c">${i + 1}</td>
    <td>${escapeHtml(r.name)}<div class="sub">${escapeHtml(r.position)}</div></td>
    <td class="r">${RU(r.accrued)}</td>
    <td class="r">${r.advance ? RU(r.advance) : '—'}</td>
    <td class="r">${r.deductions ? RU(r.deductions) : '—'}</td>
    <td class="r b">${RU(r.toPay)}</td>
    <td class="sig"></td>
  </tr>`).join('')
  return `<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>Ведомость на выплату — ${escapeHtml(periodLabel)}</title>
  <style>
    *{box-sizing:border-box}
    body{font-family:Arial,Helvetica,sans-serif;color:#111;margin:24px;font-size:12px}
    h1{font-size:16px;margin:0 0 2px}
    .meta{color:#555;margin-bottom:14px}
    table{width:100%;border-collapse:collapse}
    th,td{border:1px solid #999;padding:6px 8px;vertical-align:top}
    th{background:#f0f0f0;text-align:left}
    td.c{text-align:center;color:#666}
    td.r,th.r{text-align:right;white-space:nowrap}
    td.b{font-weight:bold}
    .sub{color:#666;font-size:10px;margin-top:1px}
    td.sig{width:130px}
    tfoot td{font-weight:bold;background:#f7f7f7}
    .signs{display:flex;justify-content:space-between;margin-top:34px}
    .signs .line{border-bottom:1px solid #333;display:inline-block;width:160px}
    @media print{body{margin:0}@page{margin:16mm}}
  </style></head><body>
    <h1>Ведомость на выплату зарплаты</h1>
    <div class="meta">Период: ${escapeHtml(periodLabel)} · Сотрудников: ${rows.length}</div>
    <table>
      <thead><tr>
        <th class="c">№</th><th>Сотрудник</th>
        <th class="r">Начислено</th><th class="r">Аванс</th><th class="r">Удержания</th>
        <th class="r">К выплате</th><th>Подпись</th>
      </tr></thead>
      <tbody>${body}</tbody>
      <tfoot><tr>
        <td></td><td>Итого · ${rows.length} чел.</td>
        <td class="r">${RU(t.accrued)}</td><td class="r">${RU(t.advance)}</td>
        <td class="r">${RU(t.deductions)}</td><td class="r">${RU(t.toPay)}</td><td></td>
      </tr></tfoot>
    </table>
    <div class="signs">
      <div>Составил: <span class="line"></span></div>
      <div>Выдал: <span class="line"></span></div>
      <div>Дата: ${escapeHtml(new Date().toLocaleDateString('ru-RU'))}</div>
    </div>
  </body></html>`
}

export function PayrollVedomost({ rows, periodLabel }: { rows: VedomostRow[]; periodLabel: string }) {
  const totals: VedomostRow = {
    id: '', name: '', position: '',
    accrued: rows.reduce((s, r) => s + r.accrued, 0),
    advance: rows.reduce((s, r) => s + r.advance, 0),
    deductions: rows.reduce((s, r) => s + r.deductions, 0),
    toPay: rows.reduce((s, r) => s + r.toPay, 0),
  }

  const doExcel = () => {
    exportToExcel(
      rows.map((r, i) => ({
        n: i + 1, name: r.name, position: r.position,
        accrued: r.accrued, advance: r.advance, deductions: r.deductions, toPay: r.toPay,
      })),
      [
        { key: 'n', header: '№' },
        { key: 'name', header: 'Сотрудник' },
        { key: 'position', header: 'Должность' },
        { key: 'accrued', header: 'Начислено' },
        { key: 'advance', header: 'Аванс' },
        { key: 'deductions', header: 'Удержания' },
        { key: 'toPay', header: 'К выплате' },
      ],
      `Ведомость ${periodLabel}`,
    )
  }

  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <FileText className="size-4 text-primary" />
          <div>
            <h2 className="text-sm font-semibold text-foreground">Ведомость на выплату</h2>
            <p className="text-xs text-muted-foreground">{periodLabel} · {rows.length} сотрудников</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => printHTML(buildPrintHTML(periodLabel, rows, totals))}
            disabled={rows.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium text-white bg-primary hover:bg-primary/90 rounded-lg transition-colors disabled:opacity-40"
          >
            <Printer className="size-3.5" />Печать
          </button>
          <button
            onClick={doExcel}
            disabled={rows.length === 0}
            className="flex items-center gap-1.5 px-3 py-2 text-xs font-medium border border-border rounded-lg hover:bg-muted transition-colors disabled:opacity-40"
          >
            <Download className="size-3.5" />Excel
          </button>
        </div>
      </div>

      <div className="bg-card rounded-xl border border-border overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[720px]">
            <thead>
              <tr className="border-b border-border bg-muted/40 text-xs font-semibold text-muted-foreground uppercase">
                <th className="px-3 py-3 text-center w-10">№</th>
                <th className="px-4 py-3 text-left">Сотрудник</th>
                <th className="px-4 py-3 text-right">Начислено</th>
                <th className="px-4 py-3 text-right">Аванс</th>
                <th className="px-4 py-3 text-right">Удержания</th>
                <th className="px-4 py-3 text-right">К выплате</th>
                <th className="px-4 py-3 text-left w-32">Подпись</th>
              </tr>
            </thead>
            <tbody>
              {rows.length === 0 && (
                <tr><td colSpan={7} className="px-4 py-8 text-center text-muted-foreground text-sm">За период некому начислять</td></tr>
              )}
              {rows.map((r, i) => (
                <tr key={r.id} className="border-b border-border last:border-0 hover:bg-muted/20">
                  <td className="px-3 py-2.5 text-center text-xs text-muted-foreground">{i + 1}</td>
                  <td className="px-4 py-2.5">
                    <div className="font-medium text-foreground">{r.name}</div>
                    <div className="text-[11px] text-muted-foreground">{r.position}</div>
                  </td>
                  <td className="px-4 py-2.5 text-right tabular-nums">{formatCurrency(r.accrued)}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-amber-600">{r.advance ? formatCurrency(r.advance) : <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums text-destructive">{r.deductions ? formatCurrency(r.deductions) : <span className="text-muted-foreground">—</span>}</td>
                  <td className="px-4 py-2.5 text-right tabular-nums font-bold text-foreground">{formatCurrency(r.toPay)}</td>
                  <td className="px-4 py-2.5"><span className="block border-b border-dashed border-muted-foreground/40 h-4" /></td>
                </tr>
              ))}
            </tbody>
            {rows.length > 0 && (
              <tfoot>
                <tr className="bg-muted/40 border-t border-border font-bold">
                  <td className="px-3 py-3" />
                  <td className="px-4 py-3 text-xs text-muted-foreground uppercase">Итого · {rows.length} чел.</td>
                  <td className="px-4 py-3 text-right tabular-nums text-foreground">{formatCurrency(totals.accrued)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-amber-600">{formatCurrency(totals.advance)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-destructive">{formatCurrency(totals.deductions)}</td>
                  <td className="px-4 py-3 text-right tabular-nums text-emerald-600">{formatCurrency(totals.toPay)}</td>
                  <td className="px-4 py-3" />
                </tr>
              </tfoot>
            )}
          </table>
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-between gap-4 px-1 text-xs text-muted-foreground">
        <span>Составил: <span className="inline-block w-36 border-b border-muted-foreground/40" /></span>
        <span>Выдал: <span className="inline-block w-36 border-b border-muted-foreground/40" /></span>
        <span>Дата: {new Date().toLocaleDateString('ru-RU')}</span>
      </div>
    </div>
  )
}
