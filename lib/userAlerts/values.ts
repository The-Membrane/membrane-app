/**
 * CURRENT VALUES for user threshold alerts. Server-side. One reading per
 * (metric, subject), each naming its true source and its as-of, each classified
 * ok / stale / unavailable by that source's own cadence × 2 (evaluate.ts readingFrom).
 * A stale or unavailable reading is never evaluated (evaluate.ts).
 *
 *  price        Chainlink USD aggregator proxies on Ethereum mainnet, read through
 *               getMainnetClient() (lib/position-sim/rpc.ts). VERIFIED on-chain
 *               2026-10-14: both answer decimals() = 8 and the descriptions below; the
 *               reader re-checks both on every read and refuses a mismatch.
 *               as-of = latestRoundData.updatedAt. Cadence: 1h heartbeat (0.5%
 *               deviation) → stale after 2h.
 *  utilization  The recorder's latest OBSERVED venue_snapshots row,
 *               params.utilization_pct — the same row /api/venues/[venue]/summary
 *               serves to the venue page's "utilization" stat. as-of = observed_at.
 *               Cadence: the hourly recorder tick → stale after 2h.
 *  apr          The venue's supply APR now (ratesNow at zero size) from the net-APY
 *               chain read the venue page's "Net at your size" card uses
 *               (lib/netApy): the route's stored set when it is fresh (≤ 120 s),
 *               else this venue read at the finalized anchor. as-of = the anchor
 *               block's time. Cadence: the route re-reads every 120 s → stale when
 *               the read is older than 240 s, or the finalized anchor itself is
 *               older than 2 × its normal ~19 min lag (finality stalled).
 */

import { getMainnetClient } from '@/lib/position-sim/rpc'
import { ratesNow } from '@/lib/netApy/irm'
import { readAllVenues, type SnapshotSet } from '@/lib/netApy/read'
import { netApyClient, redactError } from '@/lib/netApy/rpc'
import { loadLatestSnapshotSet } from '@/lib/netApy/store'
import { asOfOf } from '@/lib/netApy/types'
import { venueByKey } from '@/lib/netApy/venues'

import { readingFrom, readingKey, type Reading } from './evaluate'
import { parseSubject, PRICE_ASSETS, type Metric, type PriceAsset } from './metrics'

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>

export const CHAINLINK_FEEDS: Record<PriceAsset, { proxy: `0x${string}`; description: string; decimals: number; heartbeatS: number }> = {
  ETH: { proxy: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', description: 'ETH / USD', decimals: 8, heartbeatS: 3600 },
  BTC: { proxy: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', description: 'BTC / USD', decimals: 8, heartbeatS: 3600 },
}

export const RECORDER_CADENCE_S = 3600
export const UTILIZATION_MAX_AGE_S = 2 * RECORDER_CADENCE_S
/** The net-APY route's live-read reuse window (pages/api/net-apy LATEST_MAX_AGE_S). */
export const NET_APY_REUSE_S = 120
export const APR_READ_MAX_AGE_S = 2 * NET_APY_REUSE_S
/** The finalized anchor is ~13–19 min old when read (lib/netApy/read.ts resolveAnchor). */
export const APR_ANCHOR_MAX_AGE_S = 2 * 19 * 60

const AGGREGATOR_ABI = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'uint8' }] },
  { type: 'function', name: 'description', stateMutability: 'view', inputs: [], outputs: [{ name: '', type: 'string' }] },
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
] as const

/** The one viem method the price reader uses — a fake in tests. */
export type ContractReader = {
  readContract: (args: { address: `0x${string}`; abi: typeof AGGREGATOR_ABI; functionName: string }) => Promise<unknown>
}

export type ValueSources = {
  price: (asset: PriceAsset) => Promise<Reading>
  utilization: (venue: string) => Promise<Reading>
  apr: (venue: string) => Promise<Reading>
}

export type Need = { metric: Metric; subject: string }

const unavailable = (source: string, reason: string): Reading => ({ status: 'unavailable', source, reason })

/** Chainlink USD price for one asset, feed identity re-checked on every read. */
export const chainlinkPrice =
  (client: () => ContractReader, nowMs: () => number = Date.now) =>
  async (asset: PriceAsset): Promise<Reading> => {
    const feed = CHAINLINK_FEEDS[asset]
    const source = `Chainlink ${feed.description}`
    try {
      const c = client()
      const read = (functionName: string) => c.readContract({ address: feed.proxy, abi: AGGREGATOR_ABI, functionName })
      const [decimals, description, round] = await Promise.all([read('decimals'), read('description'), read('latestRoundData')])
      if (Number(decimals) !== feed.decimals || description !== feed.description) {
        return unavailable(source, 'feed check failed')
      }
      const [, answer, , updatedAt] = round as readonly [bigint, bigint, bigint, bigint, bigint]
      if (typeof answer !== 'bigint' || answer <= 0n) return unavailable(source, 'no positive answer')
      return readingFrom({
        value: Number(answer) / 10 ** feed.decimals,
        asOfMs: Number(updatedAt) * 1000,
        nowMs: nowMs(),
        maxAgeS: 2 * feed.heartbeatS,
        source,
      })
    } catch (e) {
      return unavailable(source, redactError(e))
    }
  }

/** The recorder's latest observed utilization for one venue (the venue page's stat). */
export const recorderUtilization =
  (sql: () => Sql, nowMs: () => number = Date.now) =>
  async (venue: string): Promise<Reading> => {
    const source = 'Membrane recorder · debt / (debt + available)'
    try {
      const [row] = await sql()`
        SELECT observed_at AS "observedAt", params->>'utilization_pct' AS "utilizationPct"
        FROM venue_snapshots
        WHERE venue = ${venue} AND source = 'observed'
        ORDER BY observed_at DESC
        LIMIT 1`
      if (!row) return unavailable(source, 'no observed snapshot')
      const u = row.utilizationPct === null || row.utilizationPct === undefined ? null : Number(row.utilizationPct)
      if (u === null) return unavailable(source, 'no utilization in the latest snapshot')
      return readingFrom({
        value: u,
        asOfMs: new Date(row.observedAt).getTime(),
        nowMs: nowMs(),
        maxAgeS: UTILIZATION_MAX_AGE_S,
        source,
      })
    } catch (e) {
      return unavailable(source, redactError(e))
    }
  }

export type AprSnapshot = {
  /** Fraction per year (0.05 = 5%). */
  supplyApr: number
  /** Wall clock of the read, unix seconds. */
  readAtS: number
  /** The finalized anchor block's timestamp, unix seconds. */
  anchorTs: number
  block: string
}

/** Supply APR now, in percent, from a net-APY snapshot. */
export const netApySupplyApr =
  (read: (venueKey: string) => Promise<AprSnapshot>, nowMs: () => number = Date.now) =>
  async (venue: string): Promise<Reading> => {
    const label = venueByKey(venue)?.label ?? venue
    let snap: AprSnapshot
    try {
      snap = await read(venue)
    } catch (e) {
      return unavailable(`${label} supply APR · on-chain`, redactError(e))
    }
    const source = `${label} supply APR · on-chain at block ${snap.block}`
    const now = nowMs()
    if (now - snap.readAtS * 1000 > APR_READ_MAX_AGE_S * 1000) {
      return { status: 'stale', value: snap.supplyApr * 100, asOf: new Date(snap.anchorTs * 1000).toISOString(), source, maxAgeS: APR_READ_MAX_AGE_S }
    }
    return readingFrom({
      value: snap.supplyApr * 100,
      asOfMs: snap.anchorTs * 1000,
      nowMs: now,
      maxAgeS: APR_ANCHOR_MAX_AGE_S,
      source,
    })
  }

/**
 * The real net-APY read for one venue. NEVER saves its one-venue set: the route's
 * store serves whole sets, and a partial newest set would hide the other venues.
 */
async function readAprSnapshot(venueKey: string): Promise<AprSnapshot> {
  const def = venueByKey(venueKey)
  if (!def) throw new Error('venue not in the net-APY registry')
  const stored = loadLatestSnapshotSet(NET_APY_REUSE_S)
  let set: SnapshotSet | null = stored && stored.snapshots.some((s) => s.venueKey === venueKey) ? stored : null
  if (!set) {
    const { client, label } = netApyClient()
    set = await readAllVenues(client, [def], label)
  }
  const snap = set.snapshots.find((s) => s.venueKey === venueKey)
  if (!snap) throw new Error(set.errors[0]?.message ?? 'venue not read')
  return {
    supplyApr: ratesNow(snap).supplyApr,
    readAtS: asOfOf(set),
    anchorTs: Number(set.anchor.blockTimestamp),
    block: set.anchor.blockNumber.toString(),
  }
}

/** A tiny TTL cache for good readings (an unavailable one is retried next read). */
const ttl = <A extends string>(ms: number, fn: (a: A) => Promise<Reading>) => {
  const memo = new Map<A, { at: number; r: Reading }>()
  return async (a: A): Promise<Reading> => {
    const hit = memo.get(a)
    if (hit && Date.now() - hit.at < ms) return hit.r
    const r = await fn(a)
    if (r.status !== 'unavailable') memo.set(a, { at: Date.now(), r })
    return r
  }
}

let live: ValueSources | null = null

/**
 * Production wiring. Caches keep a busy feed from hammering the RPCs: price 60 s
 * (well inside its 1h heartbeat), utilization 60 s (the row changes hourly), APR
 * 120 s (the net-APY route's own reuse window).
 */
export const liveSources = (sql: () => Sql): ValueSources =>
  (live ??= {
    price: ttl(60_000, chainlinkPrice(() => getMainnetClient() as unknown as ContractReader)),
    utilization: ttl(60_000, recorderUtilization(sql)),
    apr: ttl(NET_APY_REUSE_S * 1000, netApySupplyApr(readAprSnapshot)),
  })

/** One reading per distinct need, in parallel. Never rejects. */
export async function readValues(needs: readonly Need[], sources: ValueSources): Promise<Map<string, Reading>> {
  const out = new Map<string, Reading>()
  const distinct = new Map<string, Need>()
  for (const n of needs) distinct.set(readingKey(n.metric, n.subject), n)
  await Promise.all(
    [...distinct.entries()].map(async ([key, n]) => {
      const s = parseSubject(n.subject)
      let r: Reading
      if (n.metric === 'price' && s?.kind === 'asset' && (PRICE_ASSETS as readonly string[]).includes(s.asset)) {
        r = await sources.price(s.asset as PriceAsset)
      } else if (n.metric === 'utilization' && s?.kind === 'venue') {
        r = await sources.utilization(s.venue)
      } else if (n.metric === 'apr' && s?.kind === 'venue') {
        r = await sources.apr(s.venue)
      } else {
        r = unavailable('none', 'unsupported subject')
      }
      out.set(key, r)
    }),
  )
  return out
}
