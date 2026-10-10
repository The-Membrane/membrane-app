import { getAddress, isAddress } from 'viem'

import { ALERT_EVENTS, type AlertChannel, type AlertEvent } from './consent'

// This module is deliberately pure. It does not attest a deployed contract,
// read a chain, enqueue a message, or send one.
export type FinalizedChainLog = {
  chainId: 1
  emitter: string
  transactionHash: string
  logIndex: number
  blockNumber: number
  blockHash: string
  occurredAt: string
  firstObservedAt: string
  kind: AlertEvent
  subjectAddress: string
}

export type DeliveryConsent = {
  address: string
  eventKinds: readonly AlertEvent[]
  requestedChannels: readonly AlertChannel[]
  consentAt: string
  pausedAt: string | null
  telegramConfirmedAt: string | null
  emailConfirmedAt: string | null
}

export type OutboxState =
  | 'queued'
  | 'leased'
  | 'sending'
  | 'sent'
  | 'suppressed'
  | 'dead'
  | 'uncertain'

const HASH = /^0x[a-fA-F0-9]{64}$/
const CHAIN_LOG_KINDS: readonly AlertEvent[] = [
  'delay_started',
  'position_kept',
  'curator_vault_action',
]

function instant(value: string): number | null {
  const parsed = Date.parse(value)
  return Number.isFinite(parsed) ? parsed : null
}

export function normalizeFinalizedChainLog(
  value: FinalizedChainLog | null,
): FinalizedChainLog | null {
  if (!value || typeof value !== 'object') return null
  if (
    value.chainId !== 1 ||
    !isAddress(value.emitter) ||
    !isAddress(value.subjectAddress) ||
    !HASH.test(value.transactionHash) ||
    !HASH.test(value.blockHash) ||
    !Number.isSafeInteger(value.logIndex) ||
    value.logIndex < 0 ||
    !Number.isSafeInteger(value.blockNumber) ||
    value.blockNumber <= 0 ||
    !ALERT_EVENTS.includes(value.kind) ||
    !CHAIN_LOG_KINDS.includes(value.kind)
  )
    return null
  const occurredAt = instant(value.occurredAt)
  const firstObservedAt = instant(value.firstObservedAt)
  if (occurredAt === null || firstObservedAt === null || firstObservedAt < occurredAt) return null
  return {
    ...value,
    emitter: getAddress(value.emitter).toLowerCase(),
    subjectAddress: getAddress(value.subjectAddress).toLowerCase(),
    transactionHash: value.transactionHash.toLowerCase(),
    blockHash: value.blockHash.toLowerCase(),
    occurredAt: new Date(occurredAt).toISOString(),
    firstObservedAt: new Date(firstObservedAt).toISOString(),
  }
}

export function chainLogIdentity(event: FinalizedChainLog): string | null {
  const normalized = normalizeFinalizedChainLog(event)
  if (!normalized) return null
  return `${normalized.chainId}:${normalized.emitter}:${normalized.transactionHash}:${normalized.logIndex}`
}

export function consentAllowsDelivery(
  event: FinalizedChainLog,
  consent: DeliveryConsent,
  channel: AlertChannel,
): boolean {
  const normalized = normalizeFinalizedChainLog(event)
  if (!normalized || !isAddress(consent.address) || consent.pausedAt !== null) return false
  const consentAt = instant(consent.consentAt)
  const confirmedAt = instant(
    channel === 'telegram' ? consent.telegramConfirmedAt || '' : consent.emailConfirmedAt || '',
  )
  if (consentAt === null || confirmedAt === null) return false
  return (
    getAddress(consent.address).toLowerCase() === normalized.subjectAddress &&
    consent.eventKinds.includes(normalized.kind) &&
    consent.requestedChannels.includes(channel) &&
    confirmedAt >= consentAt &&
    consentAt <= Date.parse(normalized.occurredAt) &&
    confirmedAt <= Date.parse(normalized.occurredAt) &&
    consentAt <= Date.parse(normalized.firstObservedAt) &&
    confirmedAt <= Date.parse(normalized.firstObservedAt)
  )
}

// A lease is pre-send and can be retried after expiry. Once the sender marks
// "sending", a crash or uncertain HTTP result must quarantine the row: Telegram
// provides no idempotency key and an automatic retry could duplicate a notice.
export function stateAfterLeaseExpiry(state: OutboxState): OutboxState {
  if (state === 'leased') return 'queued'
  if (state === 'sending') return 'uncertain'
  return state
}

export function retiredQueuedState(attempts: number, eligibleNow: boolean): OutboxState {
  if (!Number.isSafeInteger(attempts) || attempts < 0) throw new Error('invalid attempt count')
  if (attempts >= 5) return 'dead'
  return eligibleNow ? 'queued' : 'suppressed'
}
