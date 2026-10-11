import { describe, expect, it } from 'vitest'

import { publicRouteData, publicUsdePilotData } from '@/lib/carry/publicRouteData'

describe('public route reading', () => {
  it('qualifies the sGHO cash field even for an older stored row', () => {
    expect(
      publicRouteData('destination_tvl', {
        vaultCashGho: 100,
        totalAssetsGho: 90,
        withdrawalsPaused: true,
        vaultCashMeaning: 'cash is instant capacity',
      }).vaultCashMeaning,
    ).toMatch(/compare with totalAssets and paused status/)
  })
  it('projects matched aggregate fields without wallet-level rows or receipt proofs', () => {
    expect(
      publicRouteData('matched_capital', {
        measurement: 'overlap',
        matchedGho: 42,
        rows: [{ owner: '0xprivate', debtRaw: '100' }],
        proofs: [{ tx: '0xprivate' }],
        futureSensitiveField: 'private',
      }),
    ).toEqual({ measurement: 'overlap', matchedGho: 42 })
  })

  it('projects prospective source coverage and aggregate only', () => {
    expect(
      publicRouteData('prospective_overlap', {
        matchedGho: 12,
        candidateWalletCount: 3,
        fromBlock: 26069513,
        throughBlock: 26070513,
        sourceManifestSha256: 'sha',
        qualification: 'Two-provider-agreed borrowers',
        owners: ['0xprivate'],
        rows: [{ owner: '0xprivate' }],
      }),
    ).toEqual({
      matchedGho: 12,
      candidateWalletCount: 3,
      fromBlock: 26069513,
      throughBlock: 26070513,
      sourceManifestSha256: 'sha',
      qualification:
        'Two distinct RPC hosts returned matching logs in the sealed window; independent providers are not established, and this is not a borrower census.',
    })
  })

  it('never exposes wallet rows or proofs from the USDe pilot', () => {
    expect(
      publicUsdePilotData('matched_capital', {
        claim: 'same_wallet_overlap_not_route_attributed_tvl_or_executable_exit',
        matchedUsde: '0',
        completeWalletCount: 25,
        rows: [{ owner: '0xprivate' }],
        receipts: [{ tx: '0xprivate' }],
      }),
    ).toEqual({
      claim: 'same_wallet_overlap_not_route_attributed_tvl_or_executable_exit',
      matchedUsde: '0',
      completeWalletCount: 25,
    })
    expect(
      publicUsdePilotData('matched_capital', { matchedUsde: '0', completeWalletCount: 25 }),
    ).toBeNull()
    expect(
      publicUsdePilotData('spread', {
        claim: 'modeled_two_leg_spread_not_cohort_realized_return',
        borrowApy: 0.05,
        yieldApy: 0.04,
        spread: NaN,
      }),
    ).toBeNull()
  })
})
