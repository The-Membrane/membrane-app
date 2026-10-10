import { getAddress, isAddress } from 'viem'

import { normalizeFinalizedChainLog, type FinalizedChainLog } from './outbox'

// This is an offline sender boundary, not an indexer or an enabled worker. The
// caller must attest finalized chain-1 source identity and obtain a DB lease.
// begin() must be the SQL begin_user_alert_delivery function: it rechecks the
// current consent and marks the row sending in one statement before network I/O.
export type LeasedTelegramAlert = {
  id: string
  leaseToken: string
  recipientAddress: string
  event: FinalizedChainLog | null
}

export type TelegramDeliveryPorts = {
  suppress: (id: string, leaseToken: string, reason: 'invalid_source') => Promise<boolean>
  begin: (id: string, leaseToken: string) => Promise<string | null>
  send: (chatId: string, text: string) => Promise<boolean>
  complete: (id: string, leaseToken: string) => Promise<boolean>
}

export type TelegramDispatchResult =
  | 'invalid_source'
  | 'suppression_failed'
  | 'source_config_error'
  | 'emitter_mismatch'
  | 'unsupported_kind'
  | 'deferred_pre_send'
  | 'consent_revoked'
  | 'uncertain'
  | 'sent'

const ID = /^[1-9][0-9]*$/
const UUID = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/
const PRIVATE_CHAT_ID = /^[1-9][0-9]{0,19}$/
const POSITION_ID = /^[1-9][0-9]*$/

function shortAddress(address: string): string {
  return `${address.slice(0, 6)}…${address.slice(-4)}`
}

function delayAnchor(event: FinalizedChainLog): { positionId: string; startedAt: string } | null {
  const positionId = (event as FinalizedChainLog & { positionId?: unknown }).positionId
  const startTime = (event as FinalizedChainLog & { startTime?: unknown }).startTime
  if (
    typeof positionId !== 'string' ||
    !POSITION_ID.test(positionId) ||
    typeof startTime !== 'number' ||
    !Number.isSafeInteger(startTime) ||
    startTime <= 0 ||
    startTime * 1000 !== Date.parse(event.occurredAt)
  )
    return null
  return { positionId, startedAt: new Date(startTime * 1000).toISOString() }
}

function messageFor(event: FinalizedChainLog): string | null {
  if (event.kind === 'delay_started') {
    const anchor = delayAnchor(event)
    if (!anchor) return null
    return [
      'Membrane · protection delay started',
      `Position ${anchor.positionId} · ${shortAddress(event.subjectAddress)}`,
      `Delay started at ${anchor.startedAt} (UTC). This is a start notice, not a live countdown; check the position for its current state.`,
      `Ethereum block ${event.blockNumber} · ${event.occurredAt}`,
      `Transaction ${event.transactionHash}`,
    ].join('\n')
  }
  if (event.kind === 'position_kept') {
    return [
      'Membrane · Position Kept',
      `An onchain protection outcome was recorded for ${shortAddress(event.subjectAddress)}. Check the position for its current state.`,
      `Ethereum block ${event.blockNumber} · ${event.occurredAt}`,
      `Transaction ${event.transactionHash}`,
    ].join('\n')
  }
  // CuratorVault recipients/actions are not yet specified. Never infer them.
  return null
}

/** Process one already-leased Telegram row. Never retry after begin/send ambiguity. */
export async function dispatchLeasedTelegramAlert(
  lease: LeasedTelegramAlert,
  expectedEmitter: string,
  ports: TelegramDeliveryPorts,
): Promise<TelegramDispatchResult> {
  if (!lease || typeof lease !== 'object') return 'invalid_source'
  const event = normalizeFinalizedChainLog(lease.event)
  const validLease = ID.test(lease.id) && UUID.test(lease.leaseToken)
  if (!isAddress(expectedEmitter)) return 'source_config_error'
  const suppressInvalid = async (): Promise<TelegramDispatchResult> => {
    try {
      return (await ports.suppress(lease.id, lease.leaseToken, 'invalid_source'))
        ? 'invalid_source'
        : 'suppression_failed'
    } catch {
      return 'suppression_failed'
    }
  }
  if (
    !validLease ||
    !isAddress(lease.recipientAddress) ||
    !event ||
    event.subjectAddress !== getAddress(lease.recipientAddress).toLowerCase()
  ) {
    return validLease ? suppressInvalid() : 'invalid_source'
  }
  // A wrong deployment setting and a forged row look identical here. Do not
  // terminally suppress potentially valid rows until an operator resolves it.
  if (event.emitter !== getAddress(expectedEmitter).toLowerCase()) return 'emitter_mismatch'

  if (event.kind === 'delay_started' && !delayAnchor(event)) return suppressInvalid()

  const message = messageFor(event)
  // An intended future event is not a poison source row. The caller must not
  // lease unsupported kinds until the recipient rule and message are approved.
  if (!message) return 'unsupported_kind'

  let destination: string | null
  try {
    destination = await ports.begin(lease.id, lease.leaseToken)
  } catch {
    // No send was attempted. The pre-send lease can expire and requeue.
    return 'deferred_pre_send'
  }
  if (destination === null) return 'consent_revoked'
  // begin() has already marked the row sending. Even a malformed destination
  // must now expire to uncertain, never fall back to automatic retry.
  if (!PRIVATE_CHAT_ID.test(destination)) return 'uncertain'

  try {
    if (!(await ports.send(destination, message))) return 'uncertain'
  } catch {
    return 'uncertain'
  }
  try {
    return (await ports.complete(lease.id, lease.leaseToken)) ? 'sent' : 'uncertain'
  } catch {
    return 'uncertain'
  }
}
