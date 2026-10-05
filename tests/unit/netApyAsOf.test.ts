import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterEach, describe, expect, it } from 'vitest'

import { bigintReviver } from '@/lib/netApy/fixedPoint'
import { extractCampaigns, type MerklOpportunity } from '@/lib/netApy/incentives'
import { AnchorNotFinalizedError, resolveAnchor, type SnapshotSet } from '@/lib/netApy/read'
import { handleNetApy, parseQuery, type NetApyVenueResponse } from '@/lib/netApy/service'
import { loadLatestSnapshotSet, loadPinnedSnapshotSet, saveSnapshotSet } from '@/lib/netApy/store'
import type { VenueSnapshot } from '@/lib/netApy/types'
import { venueByKey } from '@/lib/netApy/venues'

// The anchor is the FINALIZED block (~13–19 min old). Wall-clock questions — cache
// age, which campaigns are live, days left — must use the read's `asOf`.

const fx = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'net-apy-irm.json'), 'utf8'),
  bigintReviver,
) as {
  anchor: VenueSnapshot['anchor']
  rpc: string
  snapshots: VenueSnapshot[]
}
const merkl = JSON.parse(
  readFileSync(join(__dirname, 'fixtures', 'merkl-opportunities-2026-10-05.json'), 'utf8'),
) as {
  opportunities: MerklOpportunity[]
}
const vaultOf = (k: string) => {
  const d = venueByKey(k)
  return d && d.protocol === 'euler-v2' ? d.vault : null
}
const anchorTs = Number(fx.anchor.blockTimestamp)
// The first covered campaign to end after the anchor block.
const ending = extractCampaigns(merkl.opportunities, fx.snapshots, vaultOf, anchorTs).sort(
  (a, b) => a.endTs - b.endTs,
)[0]

const venueCampaignIds = async (set: SnapshotSet) => {
  const r = (await handleNetApy(parseQuery({ venue: ending.venueKey, size: '100000' }), {
    snapshots: async () => set,
    merkl: async () => ({ fetchedAt: set.asOf ?? anchorTs, opportunities: merkl.opportunities }),
  })) as NetApyVenueResponse
  const { eligible, conditional } = r.breakdown.incentives
  return { ids: [...eligible, ...conditional].map((c) => c.campaignId), asOf: r.breakdown.asOf }
}

describe('campaign liveness uses asOf, not the finalized anchor time', () => {
  it('fixture has a covered campaign live at the anchor', () => {
    expect(ending).toBeDefined()
    expect(ending.endTs).toBeGreaterThan(anchorTs)
  })

  it('a campaign that ended between the anchor block and asOf is not live', async () => {
    const asOf = ending.endTs + 1
    const r = await venueCampaignIds({
      anchor: fx.anchor,
      asOf,
      rpc: fx.rpc,
      snapshots: fx.snapshots,
      errors: [],
    })
    expect(r.ids).not.toContain(ending.campaignId)
    expect(r.asOf).toBe(asOf)
  })

  it('a set stored before asOf existed falls back to the anchor time', async () => {
    const r = await venueCampaignIds({
      anchor: fx.anchor,
      rpc: fx.rpc,
      snapshots: fx.snapshots,
      errors: [],
    })
    expect(r.ids).toContain(ending.campaignId)
    expect(r.asOf).toBe(anchorTs)
  })
})

describe('the live-read cache is measured from asOf', () => {
  let dir: string | null = null
  afterEach(() => {
    delete process.env.NET_APY_STORE_DIR
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('a finalized read made 10 s ago is fresh even though its block is 15 min old', () => {
    dir = mkdtempSync(join(tmpdir(), 'net-apy-asof-'))
    process.env.NET_APY_STORE_DIR = dir
    const now = anchorTs + 900
    saveSnapshotSet({
      anchor: fx.anchor,
      asOf: now - 10,
      rpc: fx.rpc,
      snapshots: fx.snapshots,
      errors: [],
    })
    expect(loadLatestSnapshotSet(120, now)?.asOf).toBe(now - 10)
    // The same block stored without asOf is judged by its anchor time: 900 s > 120 s.
    saveSnapshotSet({ anchor: fx.anchor, rpc: fx.rpc, snapshots: fx.snapshots, errors: [] })
    expect(loadLatestSnapshotSet(120, now)).toBeNull()
  })
})

describe('pinned anchors keep the finalized contract', () => {
  const FINALIZED = 26_120_000n
  const client = {
    getBlock: async (q: { blockTag?: string; blockNumber?: bigint }) => {
      const n = q.blockTag === 'finalized' ? FINALIZED : q.blockNumber!
      return { number: n, timestamp: 1_700_000_000n + n, hash: `0x${'ab'.repeat(32)}` }
    },
  } as unknown as Parameters<typeof resolveAnchor>[0]

  it('refuses a pinned block above finalized (it could be reorged, and would outrank the live set)', async () => {
    await expect(resolveAnchor(client, FINALIZED + 1n)).rejects.toBeInstanceOf(
      AnchorNotFinalizedError,
    )
  })

  it('accepts a pinned block at or below finalized, and the unpinned read is the finalized block', async () => {
    expect((await resolveAnchor(client, FINALIZED)).blockNumber).toBe(FINALIZED)
    expect((await resolveAnchor(client, FINALIZED - 5n)).blockNumber).toBe(FINALIZED - 5n)
    expect((await resolveAnchor(client)).blockNumber).toBe(FINALIZED)
  })
})

describe('a pinned replay of a stored live read uses the block time', () => {
  let dir: string | null = null
  afterEach(() => {
    delete process.env.NET_APY_STORE_DIR
    if (dir) rmSync(dir, { recursive: true, force: true })
    dir = null
  })

  it('loadPinnedSnapshotSet resets asOf to the anchor time', () => {
    dir = mkdtempSync(join(tmpdir(), 'net-apy-pinned-'))
    process.env.NET_APY_STORE_DIR = dir
    saveSnapshotSet({
      anchor: fx.anchor,
      asOf: anchorTs + 900,
      rpc: fx.rpc,
      snapshots: fx.snapshots,
      errors: [],
    })
    expect(loadPinnedSnapshotSet(fx.anchor.blockNumber)?.asOf).toBe(anchorTs)
    // The live path still sees the read's own wall clock.
    expect(loadLatestSnapshotSet(Number.POSITIVE_INFINITY)?.asOf).toBe(anchorTs + 900)
  })
})
