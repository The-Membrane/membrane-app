import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { bigintReviver } from '@/lib/netApy/fixedPoint'
import {
  aprAtSize,
  conditionsOf,
  decayCalendar,
  dilutionOf,
  extractCampaigns,
  fetchMerklOpportunities,
  INCENTIVE_COVERAGE,
  type IncentiveCampaign,
  trimOpportunity,
  type MerklOpportunity,
} from '@/lib/netApy/incentives'
import type { VenueSnapshot } from '@/lib/netApy/types'
import { venueByKey } from '@/lib/netApy/venues'

// Real Merkl payloads (trimmed) and real snapshots at the pinned block: matching is by
// the on-chain aToken / debt token / market id the reader returned, never by name.
const merkl = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'merkl-opportunities-2026-10-05.json'), 'utf8')) as {
  opportunities: MerklOpportunity[]
}
const snaps = (
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'net-apy-irm.json'), 'utf8'), bigintReviver) as { snapshots: VenueSnapshot[] }
).snapshots
const vaultOf = (k: string) => {
  const d = venueByKey(k)
  return d && d.protocol === 'euler-v2' ? d.vault : null
}
const NOW = 1_791_129_035 // the pinned block's timestamp

const campaign = (o: Partial<IncentiveCampaign> = {}): IncentiveCampaign => ({
  source: 'merkl',
  campaignId: 'c1',
  venueKey: 'aave-v3-usdc',
  side: 'supply',
  name: 'x',
  rewardSymbol: 'R',
  aprReported: 0.04,
  distributionType: 'DUTCH_AUCTION',
  dilution: 'fixed-budget',
  tvlUsd: 1_000_000,
  startTs: NOW - 100,
  endTs: NOW + 7 * 86_400,
  conditions: [],
  plainDepositEligible: true,
  ...o,
})

describe('Merkl → venue matching (real payloads, real on-chain addresses)', () => {
  const found = extractCampaigns(merkl.opportunities, snaps, vaultOf, NOW)

  it('matches exactly the two campaigns that pay covered venues, by token address', () => {
    expect(found.map((c) => [c.venueKey, c.side]).sort()).toEqual([
      ['aave-v3-usde', 'supply'],
      ['aave-v3-usds', 'supply'],
    ])
  })

  it('ignores Aave v4 / Horizon, Morpho collateral, vault and other-market campaigns', () => {
    const names = found.map((c) => c.name)
    expect(names.some((n) => /V4|Horizon|collateral|vault|fxSAVE|OETH|HYBOND/.test(n))).toBe(false)
  })

  it('carries the end date, Merkl’s percent as a fraction, and the dilution class', () => {
    const usds = found.find((c) => c.venueKey === 'aave-v3-usds')!
    expect(usds.endTs).toBe(1_791_464_400) // 2026-10-08
    expect(usds.aprReported).toBeCloseTo(0.033896936451134216, 15)
    expect(usds.dilution).toBe('fixed-budget')
  })

  it('flags the Ethena USDe campaign as conditional: a plain deposit does not qualify', () => {
    const usde = found.find((c) => c.venueKey === 'aave-v3-usde')!
    expect(usde.plainDepositEligible).toBe(false)
    expect(usde.conditions).toEqual(['looping required', 'health factor ≤ 2 required', 'an open borrow is required'])
  })

  it('trimming for the local store keeps every field matching reads', () => {
    expect(extractCampaigns(merkl.opportunities.map(trimOpportunity), snaps, vaultOf, NOW)).toEqual(found)
  })

  it('drops campaigns that already ended', () => {
    expect(extractCampaigns(merkl.opportunities, snaps, vaultOf, 1_791_600_000)).toEqual([])
  })
})

describe('a campaign is live only once it has started', () => {
  const live = extractCampaigns(merkl.opportunities, snaps, vaultOf, NOW)[0]
  const START = NOW + 3_600
  // The same real payload, with one matched campaign's start moved (or removed).
  const startingAt = (start: number | undefined): MerklOpportunity[] =>
    merkl.opportunities.map((o) => ({
      ...o,
      campaigns: (o.campaigns ?? []).map((c) =>
        c.campaignId === live.campaignId ? { ...c, startTimestamp: start as number } : c,
      ),
    }))
  const ids = (ops: MerklOpportunity[], nowTs: number) =>
    extractCampaigns(ops, snaps, vaultOf, nowTs).map((c) => c.campaignId)

  it('excludes a campaign starting after nowTs; includes it once nowTs ≥ start', () => {
    expect(live.endTs).toBeGreaterThan(START)
    expect(ids(startingAt(START), NOW)).not.toContain(live.campaignId)
    expect(ids(startingAt(START), START - 1)).not.toContain(live.campaignId)
    expect(ids(startingAt(START), START)).toContain(live.campaignId)
  })

  it('keeps a campaign with no start time', () => {
    expect(ids(startingAt(undefined), NOW)).toContain(live.campaignId)
  })
})

describe('dilution and the decay calendar', () => {
  it('classifies Merkl distribution types', () => {
    expect(dilutionOf('DUTCH_AUCTION')).toBe('fixed-budget')
    expect(dilutionOf(undefined)).toBe('fixed-budget')
    expect(dilutionOf('AAVE_NET_APR')).toBe('fixed-budget')
    expect(dilutionOf('FIX_REWARD_VALUE_PER_LIQUIDITY_VALUE')).toBe('rate-fixed')
    expect(dilutionOf('MAX_REWARD_VALUE_PER_LIQUIDITY_VALUE')).toBe('rate-capped')
    expect(dilutionOf('TARGET_APR_WITH_MERKL')).toBe('rate-targeted')
  })

  it('a fixed budget is shared pro rata: doubling the TVL halves the APR', () => {
    expect(aprAtSize(campaign(), 1_000_000)).toBeCloseTo(0.02, 15)
    expect(aprAtSize(campaign(), 0)).toBe(0.04)
    expect(aprAtSize(campaign({ dilution: 'rate-fixed' }), 1_000_000)).toBe(0.04)
    expect(aprAtSize(campaign({ tvlUsd: null }), 1_000_000)).toBe(0.04)
  })

  it('steps down at each end date to the incentive-free floor', () => {
    const cal = decayCalendar(
      [campaign({ campaignId: 'late', endTs: NOW + 30 * 86_400, aprReported: 0.01 }), campaign({ campaignId: 'soon', endTs: NOW + 2 * 86_400 })],
      0,
      NOW,
    )
    expect(cal.aprNow).toBeCloseTo(0.05, 15)
    expect(cal.steps.map((s) => s.campaignId)).toEqual(['soon', 'late'])
    expect(cal.steps[0].aprAfter).toBeCloseTo(0.01, 15)
    expect(cal.steps[1].aprAfter).toBe(0)
  })

  it('a campaign that has not started is not in today’s APR', () => {
    expect(decayCalendar([campaign({ startTs: NOW + 10 })], 0, NOW).aprNow).toBe(0)
  })

  it('a campaign with no start time counts as started, as extractCampaigns keeps it', () => {
    const cal = decayCalendar([campaign({ startTs: undefined as unknown as number })], 0, NOW)
    expect(cal.aprNow).toBe(0.04)
    expect(cal.steps.map((s) => s.campaignId)).toEqual(['c1'])
  })
})

describe('conditions', () => {
  const opp = (name: string): MerklOpportunity => ({ chainId: 1, type: 'AAVE_SUPPLY', identifier: '0x', name })
  it('reads whitelist and token-holding hooks; a plain campaign has none', () => {
    expect(conditionsOf(opp('Lend X'), { campaignId: '1', startTimestamp: 0, endTimestamp: 1, params: { whitelist: ['0x1'] } })).toEqual({
      conditions: ['listed addresses only'],
      plainDepositEligible: false,
    })
    expect(
      conditionsOf(opp('Lend X'), { campaignId: '1', startTimestamp: 0, endTimestamp: 1, params: { hooks: [{ eligibilityTokenThreshold: '1' }] } })
        .plainDepositEligible,
    ).toBe(false)
    expect(conditionsOf(opp('Lend X'), { campaignId: '1', startTimestamp: 0, endTimestamp: 1, params: {} })).toEqual({ conditions: [], plainDepositEligible: true })
  })
})

describe('coverage and fetch', () => {
  it('declares Royco and protocol-native programs as not covered', () => {
    expect(INCENTIVE_COVERAGE.filter((c) => c.status === 'not-covered').map((c) => c.source)).toEqual(['Royco', 'protocol-native programs'])
  })

  it('pages each protocol until a short page, and fails loudly on HTTP errors', async () => {
    const calls: string[] = []
    const ok = (async (url: string) => {
      calls.push(url)
      const full = url.includes('mainProtocolId=aave') && url.includes('page=0')
      return { ok: true, status: 200, json: async () => Array.from({ length: full ? 100 : 3 }, () => ({ chainId: 1, type: 'X', identifier: '0x', name: 'n', extra: 'dropped' })) }
    }) as unknown as typeof fetch
    const out = await fetchMerklOpportunities(ok)
    expect(out.length).toBe(100 + 3 + 3 + 3 + 3)
    expect(calls.filter((u) => u.includes('mainProtocolId=aave')).length).toBe(2)
    expect(Object.keys(out[0])).not.toContain('extra')
    const bad = (async () => ({ ok: false, status: 503, json: async () => [] })) as unknown as typeof fetch
    await expect(fetchMerklOpportunities(bad)).rejects.toThrow(/HTTP 503/)
  })
})
