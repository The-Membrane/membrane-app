import { isAddress } from 'viem'

import {
  dispatchLeasedTelegramAlert,
  type TelegramDeliveryPorts,
  type TelegramDispatchResult,
} from './telegramDelivery'
import type { FinalizedChainLog } from './outbox'

// Offline batch orchestration only. A live adapter must verify the deployed
// emitter, finalized block hash, exact receipt log, and wallet ownership before
// loadAttestedEvent returns. This file neither opens a DB nor sends Telegram.
export type TelegramLeaseRow = {
  id: string
  eventId: string
  recipientAddress: string
  channel: string
  leaseToken: string
}

export type TelegramBatchPorts = TelegramDeliveryPorts & {
  expireLeases: () => Promise<void>
  retireIneligible: () => Promise<void>
  lease: (limit: number, leaseSeconds: number) => Promise<TelegramLeaseRow[]>
  loadAttestedEvent: (eventId: string) => Promise<FinalizedChainLog | null>
}

export type TelegramBatchReport = {
  leased: number
  processed: number
  sent: number
  stopped: boolean
  reason: TelegramDispatchResult | 'bad_lease' | 'source_unavailable' | null
}

const POSITIVE_ID = /^[1-9][0-9]*$/

/** Bounded one-run worker core; any ambiguous/invalid result halts the batch. */
export async function runTelegramAlertBatch(
  expectedEmitter: string,
  ports: TelegramBatchPorts,
  limit = 20,
  leaseSeconds = 120,
): Promise<TelegramBatchReport> {
  if (!isAddress(expectedEmitter)) throw new Error('unverified emitter configuration')
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new Error('invalid batch limit')
  if (!Number.isInteger(leaseSeconds) || leaseSeconds < 30 || leaseSeconds > 300)
    throw new Error('invalid lease duration')

  await ports.expireLeases()
  await ports.retireIneligible()
  const rows = await ports.lease(limit, leaseSeconds)
  if (!Array.isArray(rows) || rows.length > limit) throw new Error('invalid leased batch')

  const report: TelegramBatchReport = {
    leased: rows.length,
    processed: 0,
    sent: 0,
    stopped: false,
    reason: null,
  }
  const seen = new Set<string>()
  for (const row of rows) {
    if (
      !row ||
      !POSITIVE_ID.test(row.id) ||
      !POSITIVE_ID.test(row.eventId) ||
      row.channel !== 'telegram' ||
      seen.has(row.id)
    ) {
      report.stopped = true
      report.reason = 'bad_lease'
      return report
    }
    seen.add(row.id)
  }

  for (const row of rows) {
    let event: FinalizedChainLog | null
    try {
      event = await ports.loadAttestedEvent(row.eventId)
    } catch {
      report.stopped = true
      report.reason = 'source_unavailable'
      break
    }
    const outcome = await dispatchLeasedTelegramAlert(
      { id: row.id, leaseToken: row.leaseToken, recipientAddress: row.recipientAddress, event },
      expectedEmitter,
      ports,
    )
    report.processed++
    if (outcome === 'sent') {
      report.sent++
      continue
    }
    if (outcome === 'consent_revoked') continue
    report.stopped = true
    report.reason = outcome
    break
  }
  return report
}
