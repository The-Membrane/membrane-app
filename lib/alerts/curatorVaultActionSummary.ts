import { isAddress } from 'viem'

import type { VerifiedCuratorVaultAction } from './verifyCuratorVaultSource'

export type CuratorVaultActionSummary = {
  title: string
  detail: string
}

const MAX_STORED_CAP = (1n << 192n) - 1n
const WAD = 10n ** 18n

function amount(value: unknown, field: string): string {
  if (typeof value !== 'bigint' || value < 0n) throw new Error(`invalid ${field}`)
  return value.toString()
}

function address(value: unknown, field: string): string {
  if (typeof value !== 'string' || !isAddress(value)) throw new Error(`invalid ${field}`)
  return value
}

function queue(value: unknown): string {
  if (!Array.isArray(value) || !value.every((item) => typeof item === 'string' && isAddress(item)))
    throw new Error('invalid queue')
  return value.length === 0 ? 'empty' : value.join(' → ')
}

/** Factual copy only, after finalized source verification. No recipient or delivery decision. */
export function summarizeVerifiedCuratorVaultAction(
  event: VerifiedCuratorVaultAction,
): CuratorVaultActionSummary {
  if (event.status !== 'verified_finalized') throw new Error('unverified curator vault action')
  const args = event.args
  switch (event.action) {
    case 'PendingCapSubmitted': {
      const cap = args.cap
      if (typeof cap !== 'bigint' || cap > MAX_STORED_CAP) throw new Error('invalid pending cap')
      return {
        title: 'Cap increase submitted',
        detail: `Venue ${address(args.venue, 'venue')}: proposed cap ${amount(cap, 'cap')} raw units; eligible at Unix time ${amount(args.validAt, 'validAt')}. This is pending, not an applied cap.`,
      }
    }
    case 'PendingCapRevoked':
      return {
        title: 'Pending cap revoked',
        detail: `Venue ${address(args.venue, 'venue')}: a pending cap change was revoked. This event does not report a new applied cap.`,
      }
    case 'CapSet':
      return {
        title: 'Cap set',
        detail: `Venue ${address(args.venue, 'venue')}: cap set to ${amount(args.cap, 'cap')} raw units. This event records a limit, not capital movement or exit capacity.`,
      }
    case 'Reallocated': {
      const withdrawn = args.totalWithdrawn
      const supplied = args.totalSupplied
      if (typeof withdrawn !== 'bigint' || withdrawn !== supplied || withdrawn < 0n)
        throw new Error('invalid reallocation totals')
      if (withdrawn === 0n)
        return {
          title: 'Reallocation recorded; no asset movement',
          detail:
            'No aggregate withdrawal or supply was recorded. The event does not identify venue-level legs.',
        }
      return {
        title: 'Vault reallocated',
        detail: `Aggregate withdrawn ${amount(withdrawn, 'totalWithdrawn')} raw units; aggregate supplied ${amount(supplied, 'totalSupplied')} raw units. The event does not identify venue-level legs.`,
      }
    }
    case 'SupplyQueueSet':
      return {
        title: 'Supply queue set',
        detail: `Vault supply order: ${queue(args.queue)}. This records queue configuration, not an executed supply.`,
      }
    case 'WithdrawQueueSet':
      return {
        title: 'Withdraw queue set',
        detail: `Vault withdrawal order: ${queue(args.queue)}. This records queue configuration, not an executed withdrawal.`,
      }
    case 'ProtocolRateDeclared': {
      const rate = args.rateWad
      if (typeof rate !== 'bigint' || rate > WAD) throw new Error('invalid protocol rate')
      return {
        title: 'Protocol rate declared',
        detail: `Declared protocol share of realized venue yield: ${amount(rate, 'rateWad')} WAD (1e18 = 100%). This is not a standalone APR or a payment receipt.`,
      }
    }
    default:
      throw new Error('unsupported curator vault action')
  }
}
