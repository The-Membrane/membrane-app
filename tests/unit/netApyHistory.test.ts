import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { bigintReviver } from '@/lib/netApy/fixedPoint'
import { diffCampaigns, diffParams, paramFields } from '@/lib/netApy/history'
import type { IncentiveCampaign } from '@/lib/netApy/incentives'
import type { VenueSnapshot } from '@/lib/netApy/types'

const snaps = (
  JSON.parse(readFileSync(join(__dirname, 'fixtures', 'net-apy-irm.json'), 'utf8'), bigintReviver) as { snapshots: VenueSnapshot[] }
).snapshots
const NOW = 1_791_129_035

const c = (id: string, o: Partial<IncentiveCampaign> = {}): IncentiveCampaign => ({
  source: 'merkl',
  campaignId: id,
  venueKey: 'aave-v3-usds',
  side: 'supply',
  name: `campaign ${id}`,
  rewardSymbol: 'R',
  aprReported: 0.03,
  distributionType: 'DUTCH_AUCTION',
  dilution: 'fixed-budget',
  tvlUsd: 1e8,
  startTs: NOW - 86_400,
  endTs: NOW + 3 * 86_400,
  conditions: [],
  plainDepositEligible: true,
  ...o,
})

describe('campaign history between two ticks', () => {
  it('a quiet tick reports nothing', () => {
    expect(diffCampaigns([c('a')], [c('a', { aprReported: 0.025 })], NOW)).toEqual([])
  })

  it('reports a new campaign with its end date and eligibility', () => {
    expect(diffCampaigns([], [c('a')], NOW)).toEqual([
      { kind: 'campaign_new', at: NOW, venueKey: 'aave-v3-usds', side: 'supply', campaignId: 'a', name: 'campaign a', aprReported: 0.03, endTs: NOW + 3 * 86_400, plainDepositEligible: true },
    ])
  })

  it('reports an end date that moved', () => {
    const [e] = diffCampaigns([c('a')], [c('a', { endTs: NOW + 10 * 86_400 })], NOW)
    expect(e).toMatchObject({ kind: 'campaign_end_changed', fromEndTs: NOW + 3 * 86_400, toEndTs: NOW + 10 * 86_400 })
  })

  it('a campaign gone BEFORE its end date lapsed early; one gone after it simply ended', () => {
    const ev = diffCampaigns([c('early'), c('done', { endTs: NOW - 1 })], [], NOW)
    expect(ev.map((e) => [e.kind, (e as { campaignId: string }).campaignId])).toEqual([
      ['campaign_gone_early', 'early'],
      ['campaign_ended', 'done'],
    ])
  })
})

describe('parameter history between two snapshot sets', () => {
  it('the same set diffs to nothing, though balances and Morpho rateAtTarget are in it', () => {
    expect(diffParams(snaps, snaps, NOW)).toEqual([])
    const moved = snaps.map((s) =>
      s.irm.model === 'morpho-adaptive-curve' ? { ...s, irm: { ...s.irm, rateAtTarget: s.irm.rateAtTarget + 1n } } : s,
    )
    expect(diffParams(snaps, moved, NOW)).toEqual([])
  })

  it('reports a slope change on Aave and a fee change on Euler', () => {
    const next = snaps.map((s) => {
      if (s.venueKey === 'aave-v3-usdc' && s.irm.model === 'aave-rate-strategy-v2') return { ...s, irm: { ...s.irm, variableRateSlope2Bps: 2_000n } }
      if (s.venueKey === 'euler-v2-eusdc-2' && s.state.kind === 'euler-vault') return { ...s, state: { ...s.state, interestFee: 1_500n } }
      return s
    })
    expect(diffParams(snaps, next, NOW).map((e) => (e.kind === 'param_changed' ? [e.venueKey, e.field, e.from, e.to] : null))).toEqual([
      ['aave-v3-usdc', 'variableRateSlope2Bps', '1000', '2000'],
      ['euler-v2-eusdc-2', 'interestFee', '1000', '1500'],
    ])
  })

  it('a venue missing from one side (failed read) is skipped, not reported', () => {
    expect(diffParams(snaps.slice(1), snaps, NOW)).toEqual([])
    expect(diffParams(snaps, snaps.slice(1), NOW)).toEqual([])
  })

  it('every model exposes its curve parameters as strings', () => {
    for (const s of snaps) {
      const f = paramFields(s)
      expect(Object.values(f).every((v) => typeof v === 'string')).toBe(true)
      expect(Object.keys(f).length).toBeGreaterThan(1)
    }
  })
})
