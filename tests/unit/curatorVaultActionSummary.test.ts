import { describe, expect, it } from 'vitest'

import { summarizeVerifiedCuratorVaultAction } from '@/lib/alerts/curatorVaultActionSummary'
import type { CuratorVaultActionName } from '@/lib/alerts/curatorVaultEvents'
import type { VerifiedCuratorVaultAction } from '@/lib/alerts/verifyCuratorVaultSource'

const VAULT = '0x2222222222222222222222222222222222222222'
const VENUE = '0x3333333333333333333333333333333333333333'
const OTHER = '0x4444444444444444444444444444444444444444'

function verified(
  action: CuratorVaultActionName,
  args: Record<string, unknown>,
): VerifiedCuratorVaultAction {
  return {
    status: 'verified_finalized',
    chainId: 1,
    vault: VAULT,
    action,
    args,
    transactionHash: `0x${'a'.repeat(64)}`,
    logIndex: 1,
    blockNumber: 25_000_000,
    blockHash: `0x${'b'.repeat(64)}`,
    occurredAt: '2026-09-27T06:00:00.000Z',
  }
}

describe('verified CuratorVault action summaries', () => {
  it('separates a pending cap raise from an applied cap', () => {
    const summary = summarizeVerifiedCuratorVaultAction(
      verified('PendingCapSubmitted', { venue: VENUE, cap: 100n, validAt: 1_800_000_000n }),
    )
    expect(summary.title).toBe('Cap increase submitted')
    expect(summary.detail).toContain('100 raw units')
    expect(summary.detail).toContain('eligible at Unix time 1800000000')
    expect(summary.detail).toContain('pending, not an applied cap')
    expect(() =>
      summarizeVerifiedCuratorVaultAction(
        verified('PendingCapSubmitted', { venue: VENUE, cap: 1n << 192n, validAt: 1n }),
      ),
    ).toThrow('invalid pending cap')
  })

  it('does not invent a new cap on revoke', () => {
    const summary = summarizeVerifiedCuratorVaultAction(
      verified('PendingCapRevoked', { venue: VENUE }),
    )
    expect(summary.title).toBe('Pending cap revoked')
    expect(summary.detail).toContain('does not report a new applied cap')
  })

  it('labels set cap as a limit, not funds or exit capacity', () => {
    const summary = summarizeVerifiedCuratorVaultAction(
      verified('CapSet', { venue: VENUE, cap: 500n }),
    )
    expect(summary.title).toBe('Cap set')
    expect(summary.detail).toContain('500 raw units')
    expect(summary.detail).toContain('not capital movement or exit capacity')
  })

  it('keeps reallocation aggregate and does not invent venue legs', () => {
    const summary = summarizeVerifiedCuratorVaultAction(
      verified('Reallocated', { caller: OTHER, totalWithdrawn: 300n, totalSupplied: 300n }),
    )
    expect(summary.title).toBe('Vault reallocated')
    expect(summary.detail).toContain('Aggregate withdrawn 300 raw units')
    expect(summary.detail).toContain('aggregate supplied 300 raw units')
    expect(summary.detail).toContain('does not identify venue-level legs')
    expect(summary.detail).not.toContain(OTHER)
    expect(() =>
      summarizeVerifiedCuratorVaultAction(
        verified('Reallocated', { caller: OTHER, totalWithdrawn: 300n, totalSupplied: 200n }),
      ),
    ).toThrow('invalid reallocation totals')
  })

  it('does not describe a zero-total reallocation as asset movement', () => {
    const summary = summarizeVerifiedCuratorVaultAction(
      verified('Reallocated', { caller: OTHER, totalWithdrawn: 0n, totalSupplied: 0n }),
    )
    expect(summary.title).toBe('Reallocation recorded; no asset movement')
    expect(summary.detail).toContain('No aggregate withdrawal or supply was recorded')
  })

  it('shows supply queue configuration without claiming execution', () => {
    const summary = summarizeVerifiedCuratorVaultAction(
      verified('SupplyQueueSet', { caller: OTHER, queue: [VENUE, OTHER] }),
    )
    expect(summary.title).toBe('Supply queue set')
    expect(summary.detail).toContain(`${VENUE} → ${OTHER}`)
    expect(summary.detail).toContain('not an executed supply')
  })

  it('shows empty withdrawal queue configuration without claiming execution', () => {
    const summary = summarizeVerifiedCuratorVaultAction(
      verified('WithdrawQueueSet', { caller: OTHER, queue: [] }),
    )
    expect(summary.title).toBe('Withdraw queue set')
    expect(summary.detail).toContain('Vault withdrawal order: empty')
    expect(summary.detail).toContain('not an executed withdrawal')
  })

  it('labels the raw WAD rate as a declaration, not realized yield', () => {
    const summary = summarizeVerifiedCuratorVaultAction(
      verified('ProtocolRateDeclared', { rateWad: 50_000_000_000_000_000n }),
    )
    expect(summary.title).toBe('Protocol rate declared')
    expect(summary.detail).toContain('protocol share of realized venue yield')
    expect(summary.detail).toContain('50000000000000000 WAD (1e18 = 100%)')
    expect(summary.detail).toContain('not a standalone APR or a payment receipt')
    expect(() =>
      summarizeVerifiedCuratorVaultAction(
        verified('ProtocolRateDeclared', { rateWad: 1_000_000_000_000_000_001n }),
      ),
    ).toThrow('invalid protocol rate')
  })

  it('fails closed on unverified input and malformed decoded fields', () => {
    expect(() =>
      summarizeVerifiedCuratorVaultAction({
        ...verified('CapSet', { venue: VENUE, cap: 1n }),
        status: 'candidate_unfinalized',
      } as unknown as VerifiedCuratorVaultAction),
    ).toThrow('unverified')
    expect(() =>
      summarizeVerifiedCuratorVaultAction(verified('CapSet', { venue: VENUE, cap: '1' })),
    ).toThrow('invalid cap')
    expect(() =>
      summarizeVerifiedCuratorVaultAction(
        verified('SupplyQueueSet', { queue: ['not an address'] }),
      ),
    ).toThrow('invalid queue')
  })
})
