'use client'

import { useEffect, useRef } from 'react'
import { getDuePending, markRetrying, markFailed, markSuccess } from '@/lib/print-queue'
import { retryReceiptJob, retryRunnerJob, retryCancellationJob } from '@/lib/print-service'
import { releaseItemPrint, releaseItemCancelPrint } from '@/lib/queries'
import type { ReceiptPrintData } from '@/lib/print-service'
import type { CancellationRunnerData } from '@/lib/print-service'
import type { RunnerData } from '@/components/print-runner'

const TICK_MS = 2_000

// When a retry job exhausts attempts, release item claims so OTHER devices
// (or this device next time it sees the item) can pick it up. Only applies
// to runner / cancel-runner jobs (receipts have no item-level claim).
async function releaseClaimsForDeadJob(job: { kind: string; payload: unknown }) {
  try {
    const items = (job.payload as { items?: { id?: string }[] }).items
    if (!items?.length) return
    if (job.kind === 'runner') {
      for (const it of items) if (it.id) await releaseItemPrint(it.id).catch(() => {})
    } else if (job.kind === 'cancel-runner') {
      for (const it of items) if (it.id) await releaseItemCancelPrint(it.id).catch(() => {})
    }
  } catch {}
}

/**
 * Background runner that retries pending print jobs from Dexie `print_queue`.
 * Mounted globally in the (app) layout. Each tick: scan due jobs, attempt
 * print via existing transport, on success delete from queue, on failure
 * apply exponential backoff (handled inside markFailed).
 */
export function PrintQueueRunner() {
  const busy = useRef(false)

  useEffect(() => {
    let cancelled = false
    async function tick() {
      if (busy.current || cancelled) return
      busy.current = true
      try {
        const due = await getDuePending()
        for (const job of due) {
          if (!job.id) continue
          await markRetrying(job.id)
          let ok = false
          try {
            switch (job.kind) {
              case 'receipt':
                ok = await retryReceiptJob(job.payload as ReceiptPrintData, job.printerIP)
                break
              case 'runner':
                ok = await retryRunnerJob(job.payload as RunnerData, job.printerIP)
                break
              case 'cancel-runner':
                ok = await retryCancellationJob(job.payload as CancellationRunnerData, job.printerIP)
                break
            }
          } catch (e) {
            ok = false
            const isDead = await markFailed(job.id, e instanceof Error ? e.message : 'unknown_error')
            if (isDead) await releaseClaimsForDeadJob(job)
            continue
          }
          if (ok) {
            await markSuccess(job.id)
          } else {
            const isDead = await markFailed(job.id, 'transport_failed')
            if (isDead) await releaseClaimsForDeadJob(job)
          }
        }
      } finally {
        busy.current = false
      }
    }
    tick() // immediate first tick
    const id = setInterval(tick, TICK_MS)
    return () => { cancelled = true; clearInterval(id) }
  }, [])

  return null
}
