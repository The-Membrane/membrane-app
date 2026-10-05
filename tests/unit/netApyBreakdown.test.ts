import { readFileSync } from 'fs'
import { join } from 'path'
import { describe, expect, it } from 'vitest'

import { membraneSplit, netBreakdown } from '@/lib/netApy/breakdown'
import { bigintReviver } from '@/lib/netApy/fixedPoint'
import { extractCampaigns, type IncentiveCampaign, type MerklOpportunity } from '@/lib/netApy/incentives'
import type { SnapshotSet } from '@/lib/netApy/read'
import { handleNetApy, parseQuery, QueryError, serialize, type NetApyListResponse, type NetApyVenueResponse } from '@/lib/netApy/service'
import type { VenueSnapshot } from '@/lib/netApy/types'
import { usdToRaw, venueByKey } from '@/lib/netApy/venues'

const fx = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'net-apy-irm.json'), 'utf8'), bigintReviver) as {
  anchor: VenueSnapshot['anchor']
  rpc: string
  snapshots: VenueSnapshot[]
}
const merkl = JSON.parse(readFileSync(join(__dirname, 'fixtures', 'merkl-opportunities-2026-10-05.json'), 'utf8')) as {
  opportunities: MerklOpportunity[]
}
const snap = (k: string) => fx.snapshots.find((s) => s.venueKey === k)!
const vaultOf = (k: string) => {
  const d = venueByKey(k)
  return d && d.protocol === 'euler-v2' ? d.vault : null
}
const campaigns: IncentiveCampaign[] = extractCampaigns(merkl.opportunities, fx.snapshots, vaultOf, Number(fx.anchor.blockTimestamp))

describe('the CuratorVault split (mirrors settleProtocolPayment)', () => {
  it('takes the protocol leg first, then the curator leg capped at what is left', () => {
    const s = membraneSplit(0.05, { protocolShare: 0.1, curatorShare: 0.2 })
    expect(s.protocol!).toBeCloseTo(0.005, 15)
    expect(s.curator!).toBeCloseTo(0.01, 15)
    expect(s.user).toBeCloseTo(0.035, 15)
    expect(s.bound).toBe('exact')
    // 70% + 50% > 100%: the curator gets only the 30% left, the user gets nothing more taken.
    const capped = membraneSplit(0.1, { protocolShare: 0.7, curatorShare: 0.5 })
    expect(capped.curator).toBeCloseTo(0.03, 15)
    expect(capped.user).toBeCloseTo(0, 15)
  })

  it('charges nothing on a zero or negative gain', () => {
    expect(membraneSplit(-0.02, { protocolShare: 0.2, curatorShare: 0.2 })).toEqual({ protocol: 0, curator: 0, user: 0, bound: 'exact' })
  })

  it('without a supplied share, prints no number for it and makes the net an upper bound', () => {
    expect(membraneSplit(0.05, {})).toEqual({ protocol: null, curator: null, user: 0.05, bound: 'upper' })
  })
})

describe('net breakdown per (venue, size)', () => {
  it('rows chain exactly: gross − venue fee = venue APR; − shares = net', () => {
    const b = netBreakdown(snap('aave-v3-usdc'), { sizeUsd: 5_000_000, campaigns, share: { protocolShare: 0.1, curatorShare: 0.1 } })
    const row = (k: string) => b.rows.find((r) => r.key === k)!.apr!
    expect(row('gross') - row('venueFee')).toBeCloseTo(row('venueNet'), 15)
    expect(row('venueNet') - row('membraneProtocol') - row('membraneCurator')).toBeCloseTo(row('netIncentiveFree'), 15)
    expect(b.net.bound).toBe('exact')
    expect(b.net.apy!).toBeGreaterThan(b.net.apr!) // compounding
  })

  it('never prints a number for Membrane when no share is supplied — the rows say curator-set', () => {
    const b = netBreakdown(snap('aave-v3-usdc'), { sizeUsd: 100_000, campaigns })
    for (const k of ['membraneProtocol', 'membraneCurator']) {
      const r = b.rows.find((x) => x.key === k)!
      expect(r.apr).toBeNull()
      expect(r.labelClass).toBe('curator-set')
      expect(r.note).toMatch(/curator-set/)
    }
    expect(b.netIncentiveFree.bound).toBe('upper')
  })

  it('refuses a 0% Membrane share (it would print as a 0% charge)', () => {
    expect(() => netBreakdown(snap('aave-v3-usdc'), { sizeUsd: 1, share: { protocolShare: 0 } })).toThrow(/curator-set/)
  })

  it('size moves the venue rate: a $500M deposit into Aave USDC pays less than $1k', () => {
    const small = netBreakdown(snap('aave-v3-usdc'), { sizeUsd: 1_000 })
    const big = netBreakdown(snap('aave-v3-usdc'), { sizeUsd: 500_000_000 })
    expect(big.atSize!.supplyApr).toBeLessThan(small.atSize!.supplyApr)
    expect(big.rows[0].labelClass).toBe('projected')
  })

  it('a fixed-budget incentive is diluted by the size and shown with its end date', () => {
    const b = netBreakdown(snap('aave-v3-usds'), { sizeUsd: 10_000_000, campaigns })
    expect(b.incentives.eligible.length).toBe(1)
    const c = b.incentives.eligible[0]
    expect(c.aprAtSize).toBeLessThan(c.aprReported)
    const inc = b.rows.find((r) => r.key === 'incentives')!
    expect(inc.labelClass).toBe('reported')
    expect(inc.note).toBe('first campaign ends 2026-10-08')
    expect(b.net.withIncentives).toBe(true)
    expect(b.netIncentiveFree.apr!).toBeLessThan(b.net.apr!)
  })

  it('a conditional campaign (Ethena loop on Aave USDe) stays out of the net', () => {
    const b = netBreakdown(snap('aave-v3-usde'), { sizeUsd: 100_000, campaigns })
    expect(b.incentives.conditional.length).toBe(1)
    expect(b.incentives.eligible.length).toBe(0)
    expect(b.net.withIncentives).toBe(false)
    expect(b.rows.some((r) => r.key === 'incentives')).toBe(false)
  })

  it('worst case: the borrow rate at the kink and at 100% — and on Morpho, still climbing after 30 days', () => {
    const aave = netBreakdown(snap('aave-v3-usdc'), { sizeUsd: 0 }).worstCase
    expect(aave.kinkUtilization).toBeCloseTo(0.94, 12)
    expect(aave.borrowAprAtKink).toBeCloseTo(0.044, 12) // 0 + 440 bps, read on-chain
    expect(aave.borrowAprAtFull).toBeCloseTo(0.144, 12) // + 1000 bps slope2
    expect(aave.borrowAprAtFullAfter30d).toBeNull()
    const morpho = netBreakdown(snap('morpho-blue-cbbtc-usdc-86'), { sizeUsd: 0 }).worstCase
    expect(morpho.borrowAprAtFullAfter30d!).toBeGreaterThan(morpho.borrowAprAtFullAfter7d!)
    expect(morpho.borrowAprAtFullAfter7d!).toBeGreaterThan(morpho.borrowAprAtFull)
  })

  it('size checks: a borrow beyond the cash reverts and has no rate; cash after a deposit grows', () => {
    const e = snap('euler-v2-eusdc-2')
    const b = netBreakdown(e, { side: 'borrow', sizeUsd: 5_000_000 })
    expect(b.checks.reverts).toBe('more than the venue’s cash')
    expect(b.atSize).toBeNull()
    expect(b.rows[0].apr).toBeNull()
    const d = netBreakdown(e, { sizeUsd: 1_000_000 })
    expect(d.checks.cashAfterUsd).toBeGreaterThan(1_000_000)
    expect(d.checks.sizeRaw).toBe(usdToRaw(1_000_000, e.asset))
  })

  it('borrow side: no Membrane rows (it charges through deployed yield, not venue borrows)', () => {
    const b = netBreakdown(snap('spark-usds'), { side: 'borrow', sizeUsd: 1_000_000 })
    expect(b.rows.map((r) => r.key)).toEqual(['borrowRate', 'netBorrowCost'])
  })
})

describe('the /api/net-apy service', () => {
  const set: SnapshotSet = { anchor: fx.anchor, rpc: fx.rpc, snapshots: fx.snapshots, errors: [] }
  const deps = {
    snapshots: async () => set,
    merkl: async () => ({ fetchedAt: 1, opportunities: merkl.opportunities }),
  }

  it('parses and validates the query', () => {
    expect(parseQuery({})).toMatchObject({ sizeUsd: 100_000, side: 'supply', path: false })
    expect(() => parseQuery({ venue: 'nope' })).toThrow(QueryError)
    expect(() => parseQuery({ size: '-1' })).toThrow(/size/)
    expect(() => parseQuery({ protocolShare: '0' })).toThrow(/curator-set/)
    expect(() => parseQuery({ block: 'latest' })).toThrow(/block/)
    expect(parseQuery({ block: '26120000', path: '1', side: 'borrow' })).toMatchObject({ block: 26_120_000n, path: true, side: 'borrow' })
  })

  it('one venue: breakdown + the rate-spike axis, serialised without bigints', async () => {
    const r = (await handleNetApy(parseQuery({ venue: 'morpho-blue-wbtc-usdc-86', size: '2000000', path: '1' }), deps)) as NetApyVenueResponse
    expect(r.breakdown.venueKey).toBe('morpho-blue-wbtc-usdc-86')
    expect(r.rateSpike!.levels.map((l) => l.name)).toContain('at-size')
    const json = serialize(r)
    expect(json.anchor.blockNumber).toBe('26120000')
    expect(() => JSON.stringify(json)).not.toThrow()
  })

  it('all venues: one row each, incentives marked unavailable (not absent) when Merkl fails', async () => {
    const r = (await handleNetApy(parseQuery({ size: '100000' }), { ...deps, merkl: async () => { throw new Error('down https://x.example/key') } })) as NetApyListResponse
    expect(r.venues.length).toBe(fx.snapshots.length)
    expect(r.incentivesStatus).toEqual({ ok: false, fetchedAt: null, error: 'down [rpc]' })
  })
})
