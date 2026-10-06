import { existsSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bigintReviver } from '@/lib/netApy/fixedPoint'
import type { NetApyEvent } from '@/lib/netApy/history'
import { extractCampaigns, type MerklOpportunity } from '@/lib/netApy/incentives'
import type { SnapshotSet } from '@/lib/netApy/read'
import { loadEvents, loadParamBaseline, saveSnapshotSet } from '@/lib/netApy/store'
import { runNetApyTick } from '@/lib/netApy/tick'
import { asOfOf, type BlockAnchor, type VenueSnapshot } from '@/lib/netApy/types'
import { venueByKey } from '@/lib/netApy/venues'

// The recorder tick end to end against a temp store: real fixtures, injected reads.

const fx = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'net-apy-irm.json'), 'utf8'),
  bigintReviver,
) as { anchor: BlockAnchor; rpc: string; snapshots: VenueSnapshot[] }
const merkl = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'merkl-opportunities-2026-10-05.json'), 'utf8'),
) as { opportunities: MerklOpportunity[] }
const vaultOf = (k: string) => {
  const d = venueByKey(k)
  return d && d.protocol === 'euler-v2' ? d.vault : null
}

const T0 = Number(fx.anchor.blockTimestamp)
/** A finalized block is minutes old when it is read. */
const FINALITY_LAG_S = 900
const VENUE = 'aave-v3-usdc'
const SLOPE2_AT_FIXTURE = 1_000n

/**
 * A finalized read `dBlocks` after the fixture block (12 s blocks), read FINALITY_LAG_S
 * later. `slope2` sets aave-v3-usdc's slope2; `fail` lists venues whose read failed.
 */
function setAt(dBlocks: number, o: { slope2?: bigint; fail?: string[] } = {}): SnapshotSet {
  const anchor: BlockAnchor = {
    ...fx.anchor,
    blockNumber: fx.anchor.blockNumber + BigInt(dBlocks),
    blockTimestamp: fx.anchor.blockTimestamp + BigInt(dBlocks * 12),
  }
  const fail = o.fail ?? []
  const snapshots = fx.snapshots
    .filter((s) => !fail.includes(s.venueKey))
    .map((s): VenueSnapshot => {
      if (s.venueKey === VENUE && s.irm.model === 'aave-rate-strategy-v2' && o.slope2) {
        return { ...s, anchor, irm: { ...s.irm, variableRateSlope2Bps: o.slope2 } }
      }
      return { ...s, anchor }
    })
  return {
    anchor,
    asOf: Number(anchor.blockTimestamp) + FINALITY_LAG_S,
    rpc: 'env:test',
    snapshots,
    errors: fail.map((venueKey) => ({ venueKey, message: 'read failed' })),
  }
}

const tick = (set: SnapshotSet, o: { now?: number; opportunities?: MerklOpportunity[] } = {}) =>
  runNetApyTick({
    readSet: async () => set,
    fetchMerkl: async () => o.opportunities ?? merkl.opportunities,
    now: () => o.now ?? asOfOf(set),
    log: () => {},
  })

const slopeChanges = (events: readonly NetApyEvent[]) =>
  events.flatMap((e) =>
    e.kind === 'param_changed' && e.venueKey === VENUE && e.field === 'variableRateSlope2Bps'
      ? [{ block: e.block, from: e.from, to: e.to }]
      : [],
  )

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'net-apy-tick-'))
  process.env.NET_APY_STORE_DIR = dir
})
afterEach(() => {
  delete process.env.NET_APY_STORE_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('campaign liveness on the tick is the wall clock, not the finalized anchor', () => {
  // The first covered campaign to end after the fixture block.
  const ending = extractCampaigns(merkl.opportunities, fx.snapshots, vaultOf, T0).sort(
    (a, b) => a.endTs - b.endTs,
  )[0]
  // Tick 2's anchor is 10 min BEFORE the scheduled end; its wall clock is 5 min after it.
  const dBlocks = Math.floor((ending.endTs - 600 - T0) / 12)
  const without = merkl.opportunities.map((op) => ({
    ...op,
    campaigns: (op.campaigns ?? []).filter((c) => c.campaignId !== ending.campaignId),
  }))
  const forEnding = (events: readonly NetApyEvent[]) =>
    events.filter((e) => 'campaignId' in e && e.campaignId === ending.campaignId)

  it('fixture: tick 2 straddles the end (anchor before it, wall clock after it)', () => {
    const s = setAt(dBlocks)
    expect(Number(s.anchor.blockTimestamp)).toBeLessThan(ending.endTs)
    expect(asOfOf(s)).toBeGreaterThan(ending.endTs)
    expect(T0 + FINALITY_LAG_S).toBeLessThan(ending.endTs)
  })

  it('an on-time end Merkl already dropped is campaign_ended, not gone early', async () => {
    await tick(setAt(0))
    const { events } = await tick(setAt(dBlocks), { opportunities: without })
    expect(forEnding(events).map((e) => e.kind)).toEqual(['campaign_ended'])
  })

  it('the same end while Merkl still lists the campaign is campaign_ended too', async () => {
    await tick(setAt(0))
    const { events } = await tick(setAt(dBlocks))
    expect(forEnding(events).map((e) => e.kind)).toEqual(['campaign_ended'])
  })
})

describe('the tick diffs params against its own baseline', () => {
  it('a set the API stored between two ticks does not swallow a param change', async () => {
    await tick(setAt(0))
    // An API read between the ticks saw the change first and stored its set.
    saveSnapshotSet(setAt(50, { slope2: 2_000n }))
    const { events } = await tick(setAt(100, { slope2: 2_000n }))
    const want = { block: String(fx.anchor.blockNumber + 100n), from: '1000', to: '2000' }
    expect(slopeChanges(events)).toEqual([want])
    expect(slopeChanges(loadEvents())).toEqual([want])
  })

  it('a venue that fails to read keeps its baseline; its change logs next tick', async () => {
    await tick(setAt(0))
    const t2 = await tick(setAt(50, { fail: [VENUE] }))
    expect(t2.events).toEqual([])
    const kept = loadParamBaseline()?.snapshots.find((s) => s.venueKey === VENUE)
    expect(kept?.anchor.blockNumber).toBe(fx.anchor.blockNumber)
    const t3 = await tick(setAt(100, { slope2: 2_000n }))
    expect(slopeChanges(t3.events)).toEqual([
      { block: String(fx.anchor.blockNumber + 100n), from: '1000', to: '2000' },
    ])
  })

  it('never diffs backwards, and an older read does not replace the baseline', async () => {
    await tick(setAt(100, { slope2: 2_000n }))
    // A lagging RPC serves an older finalized block, from before the change.
    const back = await tick(setAt(50))
    expect(slopeChanges(back.events)).toEqual([])
    const held = loadParamBaseline()?.snapshots.find((s) => s.venueKey === VENUE)
    expect(held?.anchor.blockNumber).toBe(fx.anchor.blockNumber + 100n)
    // Back on track: nothing changed since block +100, so nothing is logged again.
    const fwd = await tick(setAt(150, { slope2: 2_000n }))
    expect(slopeChanges(fwd.events)).toEqual([])
  })

  it('migration: with no baseline file, the first tick diffs vs the newest set', async () => {
    saveSnapshotSet(setAt(0))
    expect(existsSync(join(dir, 'params-baseline.json'))).toBe(false)
    const { events } = await tick(setAt(100, { slope2: 2_000n }))
    expect(slopeChanges(events)).toEqual([
      { block: String(fx.anchor.blockNumber + 100n), from: '1000', to: '2000' },
    ])
    const base = loadParamBaseline()
    expect(base?.snapshots).toHaveLength(fx.snapshots.length)
    expect(
      base?.snapshots.every((s) => s.anchor.blockNumber === fx.anchor.blockNumber + 100n),
    ).toBe(true)
  })

  it('a tick that reads no venue exits 1 and leaves the baseline alone', async () => {
    await tick(setAt(0))
    const all = fx.snapshots.map((s) => s.venueKey)
    const r = await tick(setAt(50, { fail: all }))
    expect(r.code).toBe(1)
    expect(
      loadParamBaseline()?.snapshots.every((s) => s.anchor.blockNumber === fx.anchor.blockNumber),
    ).toBe(true)
  })

  it('fixture: aave-v3-usdc slope2 is the value the tests change from', () => {
    const s = fx.snapshots.find((x) => x.venueKey === VENUE)
    expect(s?.irm.model === 'aave-rate-strategy-v2' && s.irm.variableRateSlope2Bps).toBe(
      SLOPE2_AT_FIXTURE,
    )
  })
})
