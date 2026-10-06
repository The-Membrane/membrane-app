import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { bigintReviver } from '@/lib/netApy/fixedPoint'
import type { NetApyEvent } from '@/lib/netApy/history'
import { extractCampaigns, type MerklOpportunity } from '@/lib/netApy/incentives'
import type { SnapshotSet } from '@/lib/netApy/read'
import {
  loadCampaignState,
  loadEvents,
  loadParamBaseline,
  saveCampaignState,
  saveParamBaseline,
  saveSnapshotSet,
} from '@/lib/netApy/store'
import { runNetApyTick, TICK_LOCK_STALE_S, type NetApyTickDeps } from '@/lib/netApy/tick'
import { asOfOf, type BlockAnchor, type VenueSnapshot } from '@/lib/netApy/types'
import { NET_APY_VENUES, venueByKey } from '@/lib/netApy/venues'

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
const B0 = fx.anchor.blockNumber
/** A finalized block is minutes old when it is read. */
const FINALITY_LAG_S = 900
/** A PAID venue: a live Merkl supply campaign matches it in the fixture. */
const VENUE = 'aave-v3-usds'
const fxVenue = fx.snapshots.find((s) => s.venueKey === VENUE)!
const SLOPE2_FX =
  fxVenue.irm.model === 'aave-rate-strategy-v2' ? fxVenue.irm.variableRateSlope2Bps : 0n
const SLOPE2_NEW = SLOPE2_FX + 1_000n
const fxCampaigns = extractCampaigns(merkl.opportunities, fx.snapshots, vaultOf, T0)
const paid = fxCampaigns.find((c) => c.venueKey === VENUE)!

/**
 * A finalized read `dBlocks` after the fixture block (12 s blocks), read FINALITY_LAG_S
 * later. `slope2` sets VENUE's slope2; `fail` lists venues whose read failed.
 */
function setAt(dBlocks: number, o: { slope2?: bigint; fail?: string[] } = {}): SnapshotSet {
  const anchor: BlockAnchor = {
    ...fx.anchor,
    blockNumber: B0 + BigInt(dBlocks),
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

type TickOpts = { now?: number; opportunities?: MerklOpportunity[]; log?: string[] }
const deps = (
  set: SnapshotSet | (() => Promise<SnapshotSet>),
  o: TickOpts = {},
): NetApyTickDeps => ({
  readSet: typeof set === 'function' ? set : async () => set,
  fetchMerkl: async () => o.opportunities ?? merkl.opportunities,
  now: () => o.now ?? (typeof set === 'function' ? T0 + FINALITY_LAG_S : asOfOf(set)),
  log: (l) => o.log?.push(l),
})
const tick = (set: SnapshotSet, o: TickOpts = {}) => runNetApyTick(deps(set, o))

/** The same Merkl payload with campaigns removed or added. */
const merklWith = (
  drop: string[],
  add: {
    onCampaign: string
    campaign: Partial<{ campaignId: string; start: number; end: number }>
  }[] = [],
): MerklOpportunity[] =>
  merkl.opportunities.map((op) => {
    const campaigns = op.campaigns ?? []
    const extra = add.flatMap((a) =>
      campaigns
        .filter((c) => c.campaignId === a.onCampaign)
        .map((c) => ({
          ...c,
          campaignId: a.campaign.campaignId ?? c.campaignId,
          startTimestamp: a.campaign.start ?? c.startTimestamp,
          endTimestamp: a.campaign.end ?? c.endTimestamp,
        })),
    )
    return {
      ...op,
      campaigns: [...campaigns.filter((c) => !drop.includes(c.campaignId)), ...extra],
    }
  })

const slopeChanges = (events: readonly NetApyEvent[]) =>
  events.flatMap((e) =>
    e.kind === 'param_changed' && e.venueKey === VENUE && e.field === 'variableRateSlope2Bps'
      ? [{ block: e.block, from: e.from, to: e.to }]
      : [],
  )
const slopeChange = (dBlocks: number) => ({
  block: String(B0 + BigInt(dBlocks)),
  from: String(SLOPE2_FX),
  to: String(SLOPE2_NEW),
})
const forCampaign = (events: readonly NetApyEvent[], id: string) =>
  events.filter((e) => 'campaignId' in e && e.campaignId === id).map((e) => e.kind)
const baselineBlocks = () =>
  new Set(loadParamBaseline()?.snapshots.map((s) => s.anchor.blockNumber))

let dir = ''
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'net-apy-tick-'))
  process.env.NET_APY_STORE_DIR = dir
})
afterEach(() => {
  delete process.env.NET_APY_STORE_DIR
  rmSync(dir, { recursive: true, force: true })
})

describe('fixtures', () => {
  it('VENUE is paid, every fixture venue is registered, and slope2 can move', () => {
    expect(paid).toBeDefined()
    expect(paid.endTs).toBeGreaterThan(T0 + 86_400)
    const registered = new Set(NET_APY_VENUES.map((v) => v.venueKey))
    expect(fx.snapshots.every((s) => registered.has(s.venueKey))).toBe(true)
    expect(SLOPE2_FX).toBeGreaterThan(0n)
  })
})

describe('campaign liveness on the tick is the wall clock, not the finalized anchor', () => {
  // The first covered campaign to end after the fixture block.
  const ending = [...fxCampaigns].sort((a, b) => a.endTs - b.endTs)[0]
  // Tick 2's anchor is 10 min BEFORE the scheduled end; its wall clock is 5 min after it.
  const dBlocks = Math.floor((ending.endTs - 600 - T0) / 12)

  it('fixture: tick 2 straddles the end (anchor before it, wall clock after it)', () => {
    const s = setAt(dBlocks)
    expect(Number(s.anchor.blockTimestamp)).toBeLessThan(ending.endTs)
    expect(asOfOf(s)).toBeGreaterThan(ending.endTs)
    expect(T0 + FINALITY_LAG_S).toBeLessThan(ending.endTs)
  })

  it('an on-time end Merkl already dropped is campaign_ended, not gone early', async () => {
    await tick(setAt(0))
    const { events } = await tick(setAt(dBlocks), { opportunities: merklWith([ending.campaignId]) })
    expect(forCampaign(events, ending.campaignId)).toEqual(['campaign_ended'])
  })

  it('the same end while Merkl still lists the campaign is campaign_ended too', async () => {
    await tick(setAt(0))
    const { events } = await tick(setAt(dBlocks))
    expect(forCampaign(events, ending.campaignId)).toEqual(['campaign_ended'])
  })
})

describe('the tick diffs params against its own baseline', () => {
  it('a set the API stored between two ticks does not swallow a param change', async () => {
    await tick(setAt(0))
    // An API read between the ticks saw the change first and stored its set.
    saveSnapshotSet(setAt(50, { slope2: SLOPE2_NEW }))
    const { events } = await tick(setAt(100, { slope2: SLOPE2_NEW }))
    expect(slopeChanges(events)).toEqual([slopeChange(100)])
    expect(slopeChanges(loadEvents())).toEqual([slopeChange(100)])
  })

  it('a paid venue that fails to read keeps its baseline; its change logs next tick', async () => {
    await tick(setAt(0))
    const t2 = await tick(setAt(50, { fail: [VENUE] }))
    // Nothing at all: no param diff, and its campaign is not reported gone.
    expect(t2.events).toEqual([])
    const kept = loadParamBaseline()?.snapshots.find((s) => s.venueKey === VENUE)
    expect(kept?.anchor.blockNumber).toBe(B0)
    const t3 = await tick(setAt(100, { slope2: SLOPE2_NEW }))
    expect(slopeChanges(t3.events)).toEqual([slopeChange(100)])
    expect(t3.events).toHaveLength(1)
  })

  it('a failed read of a paid venue does not log its campaign gone and then new', async () => {
    await tick(setAt(0))
    const t2 = await tick(setAt(50, { fail: [VENUE] }))
    const t3 = await tick(setAt(100))
    expect(forCampaign([...t2.events, ...t3.events], paid.campaignId)).toEqual([])
    expect(loadCampaignState()?.campaigns.map((c) => c.campaignId)).toContain(paid.campaignId)
  })

  it('never diffs backwards, and an older read does not replace the baseline', async () => {
    await tick(setAt(100, { slope2: SLOPE2_NEW }))
    // A lagging RPC serves an older finalized block, from before the change.
    const back = await tick(setAt(50))
    expect(slopeChanges(back.events)).toEqual([])
    const held = loadParamBaseline()?.snapshots.find((s) => s.venueKey === VENUE)
    expect(held?.anchor.blockNumber).toBe(B0 + 100n)
    // Back on track: nothing changed since block +100, so nothing is logged again.
    const fwd = await tick(setAt(150, { slope2: SLOPE2_NEW }))
    expect(slopeChanges(fwd.events)).toEqual([])
  })

  it('migration: with no baseline file, the first tick diffs vs the newest set', async () => {
    saveSnapshotSet(setAt(0))
    expect(existsSync(join(dir, 'params-baseline.json'))).toBe(false)
    const { events } = await tick(setAt(100, { slope2: SLOPE2_NEW }))
    expect(slopeChanges(events)).toEqual([slopeChange(100)])
    expect(loadParamBaseline()?.snapshots).toHaveLength(fx.snapshots.length)
    expect(baselineBlocks()).toEqual(new Set([B0 + 100n]))
  })

  it('a corrupt baseline never falls back to an API set; no change is swallowed', async () => {
    await tick(setAt(0))
    writeFileSync(join(dir, 'params-baseline.json'), '{"observedAt":1,"snaps')
    // An API read on a faster RPC is AHEAD of the next tick and already holds the change.
    saveSnapshotSet(setAt(200, { slope2: SLOPE2_NEW }))
    const log: string[] = []
    const t2 = await tick(setAt(100), { log })
    expect(slopeChanges(t2.events)).toEqual([])
    expect(log.some((l) => l.includes('params-baseline.json unreadable'))).toBe(true)
    expect(baselineBlocks()).toEqual(new Set([B0 + 100n]))
    const t3 = await tick(setAt(300, { slope2: SLOPE2_NEW }))
    expect(slopeChanges(t3.events)).toEqual([slopeChange(300)])
  })

  it('a venue removed from the registry is pruned from the saved baseline', async () => {
    const base = setAt(0).snapshots
    saveParamBaseline({ observedAt: T0, snapshots: [...base, { ...base[0], venueKey: 'retired' }] })
    await tick(setAt(100))
    const keys = loadParamBaseline()?.snapshots.map((s) => s.venueKey) ?? []
    expect(keys).not.toContain('retired')
    expect(keys).toHaveLength(fx.snapshots.length)
  })

  it('a tick that reads no venue exits 1 and leaves the baseline alone', async () => {
    await tick(setAt(0))
    const r = await tick(setAt(50, { fail: fx.snapshots.map((s) => s.venueKey) }))
    expect(r.code).toBe(1)
    expect(baselineBlocks()).toEqual(new Set([B0]))
  })
})

describe('campaign state written before the start rule', () => {
  it('an upcoming campaign in old state is not gone early; it is new once started', async () => {
    await tick(setAt(0))
    const start = T0 + 2 * 3_600
    const upcoming = { campaignId: 'upcoming-1', start, end: T0 + 60 * 86_400 }
    // Merkl lists it before it starts; an old state file kept it as live.
    const ops = merklWith([], [{ onCampaign: paid.campaignId, campaign: upcoming }])
    const old = loadCampaignState()!
    const early = { ...paid, campaignId: 'upcoming-1', startTs: start, endTs: upcoming.end }
    saveCampaignState({ ...old, campaigns: [...old.campaigns, early] })
    const t2 = await tick(setAt(10), { opportunities: ops })
    expect(forCampaign(t2.events, 'upcoming-1')).toEqual([])
    const t3 = await tick(setAt(900), { opportunities: ops })
    expect(forCampaign(t3.events, 'upcoming-1')).toEqual(['campaign_new'])
  })
})

describe('a failed change-log append advances nothing', () => {
  it('no baseline moves, the tick exits 1, the next tick logs the same changes', async () => {
    await tick(setAt(0))
    const stateBefore = loadCampaignState()
    // events.jsonl as a directory: the append fails, every other write still works.
    mkdirSync(join(dir, 'events.jsonl'))
    const gone = merklWith([paid.campaignId])
    const t2 = await tick(setAt(100, { slope2: SLOPE2_NEW }), { opportunities: gone })
    expect(t2.code).toBe(1)
    expect(slopeChanges(t2.events)).toEqual([slopeChange(100)])
    expect(baselineBlocks()).toEqual(new Set([B0]))
    expect(loadCampaignState()).toEqual(stateBefore)
    rmSync(join(dir, 'events.jsonl'), { recursive: true })
    const t3 = await tick(setAt(200, { slope2: SLOPE2_NEW }), { opportunities: gone })
    expect(t3.code).toBe(0)
    expect(slopeChanges(loadEvents())).toEqual([slopeChange(200)])
    expect(forCampaign(loadEvents(), paid.campaignId)).toEqual(['campaign_gone_early'])
  })
})

describe('the tick lock', () => {
  it('an overlapping tick skips with exit 0 and writes nothing; the change logs once', async () => {
    await tick(setAt(0))
    let release = () => {}
    const gate = new Promise<void>((r) => (release = r))
    const running = runNetApyTick(
      deps(async () => {
        await gate
        return setAt(100, { slope2: SLOPE2_NEW })
      }),
    )
    const log: string[] = []
    // 30 s into the running tick (its clock is T0 + FINALITY_LAG_S): the lock is fresh.
    const skipped = await tick(setAt(100, { slope2: SLOPE2_NEW }), {
      log,
      now: T0 + FINALITY_LAG_S + 30,
    })
    expect(skipped).toEqual({ code: 0, events: [] })
    expect(log).toEqual(['[net-apy] another tick is running, skipped'])
    expect(existsSync(join(dir, `snapshots-${B0 + 100n}.json`))).toBe(false)
    release()
    expect(slopeChanges((await running).events)).toEqual([slopeChange(100)])
    expect(slopeChanges(loadEvents())).toEqual([slopeChange(100)])
    expect(existsSync(join(dir, 'tick.lock'))).toBe(false)
  })

  it('a lock older than 10 min (a crashed tick) is replaced; a younger one holds', async () => {
    const now = T0 + FINALITY_LAG_S
    writeFileSync(join(dir, 'tick.lock'), `${now - 60} 1 alive`)
    expect((await tick(setAt(0))).events).toEqual([])
    expect(loadParamBaseline()).toBeNull()
    writeFileSync(join(dir, 'tick.lock'), `${now - TICK_LOCK_STALE_S - 1} 1 crashed`)
    expect((await tick(setAt(0))).code).toBe(0)
    expect(baselineBlocks()).toEqual(new Set([B0]))
    expect(existsSync(join(dir, 'tick.lock'))).toBe(false)
  })
})
