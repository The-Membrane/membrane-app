/**
 * CURRENT VALUES for user threshold alerts. Server-side. One reading per
 * (metric, subject), each naming its true source and its as-of, each classified
 * ok / stale / unavailable by that source's own cadence × 2 (freshness.ts classify — the same max ages the UI uses).
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

import { readingKey, type Reading } from './evaluate'
import {
  APR_ANCHOR_MAX_AGE_S,
  APR_READ_MAX_AGE_S,
  CHAINLINK_HEARTBEAT_S,
  classify,
  NET_APY_REUSE_S,
  UTILIZATION_MAX_AGE_S,
  type Raw,
} from './freshness'
import { parseSubject, PRICE_ASSETS, type Metric, type PriceAsset } from './metrics'

// The max ages live in ./freshness (shared with the UI); re-exported for callers here.
export { APR_ANCHOR_MAX_AGE_S, APR_READ_MAX_AGE_S, NET_APY_REUSE_S, UTILIZATION_MAX_AGE_S }

type Sql = (strings: TemplateStringsArray, ...values: unknown[]) => Promise<any[]>

export const CHAINLINK_FEEDS: Record<PriceAsset, { proxy: `0x${string}`; description: string; decimals: number; heartbeatS: number }> = {
  ETH: { proxy: '0x5f4eC3Df9cbd43714FE2740f5E3616155c5b8419', description: 'ETH / USD', decimals: 8, heartbeatS: CHAINLINK_HEARTBEAT_S },
  BTC: { proxy: '0xF4030086522a5bEEa4988F8cA5B36dbC97BeE88c', description: 'BTC / USD', decimals: 8, heartbeatS: CHAINLINK_HEARTBEAT_S },
}

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

const unavailable = (source: string, reason: string): Raw => ({ status: 'unavailable', source, reason })

/** Chainlink USD price for one asset, feed identity re-checked on every read. Unclassified. */
export const chainlinkRaw =
  (client: () => ContractReader) =>
  async (asset: PriceAsset): Promise<Raw> => {
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
      return { status: 'raw', value: Number(answer) / 10 ** feed.decimals, asOfMs: Number(updatedAt) * 1000, source, maxAgeS: 2 * feed.heartbeatS }
    } catch (e) {
      return unavailable(source, redactError(e))
    }
  }

/** The recorder's latest observed utilization for one venue (the venue page's stat). Unclassified. */
export const utilizationRaw =
  (sql: () => Sql) =>
  async (venue: string): Promise<Raw> => {
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
      if (u === null || !Number.isFinite(u)) return unavailable(source, 'no utilization in the latest snapshot')
      return { status: 'raw', value: u, asOfMs: new Date(row.observedAt).getTime(), source, maxAgeS: UTILIZATION_MAX_AGE_S }
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

/** Supply APR now, in percent, from a net-APY snapshot. Unclassified (two ages: read, anchor). */
export const aprRaw =
  (read: (venueKey: string) => Promise<AprSnapshot>) =>
  async (venue: string): Promise<Raw> => {
    const label = venueByKey(venue)?.label ?? venue
    let snap: AprSnapshot
    try {
      snap = await read(venue)
    } catch (e) {
      return unavailable(`${label} supply APR · on-chain`, redactError(e))
    }
    return {
      status: 'raw',
      value: snap.supplyApr * 100,
      asOfMs: snap.anchorTs * 1000,
      source: `${label} supply APR · on-chain at block ${snap.block}`,
      maxAgeS: APR_ANCHOR_MAX_AGE_S,
      readAtMs: snap.readAtS * 1000,
      readMaxAgeS: APR_READ_MAX_AGE_S,
    }
  }

/** Classified readers (fetch + judge now) — the shapes tests and one-off callers use. */
export const chainlinkPrice =
  (client: () => ContractReader, nowMs: () => number = Date.now) =>
  async (asset: PriceAsset): Promise<Reading> =>
    classify(await chainlinkRaw(client)(asset), nowMs())

export const recorderUtilization =
  (sql: () => Sql, nowMs: () => number = Date.now) =>
  async (venue: string): Promise<Reading> =>
    classify(await utilizationRaw(sql)(venue), nowMs())

export const netApySupplyApr =
  (read: (venueKey: string) => Promise<AprSnapshot>, nowMs: () => number = Date.now) =>
  async (venue: string): Promise<Reading> =>
    classify(await aprRaw(read)(venue), nowMs())

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

/**
 * A TTL cache over RAW values: a hit is re-classified against the clock on every
 * use, so a cached value turns stale exactly when an uncached one would. An
 * unavailable result is not cached (retried next read).
 */
export const cachedSource = <A extends string>(ms: number, fetchRaw: (a: A) => Promise<Raw>, nowMs: () => number = Date.now) => {
  const memo = new Map<A, { at: number; raw: Raw }>()
  return async (a: A): Promise<Reading> => {
    const now = nowMs()
    const hit = memo.get(a)
    let raw: Raw
    if (hit && now - hit.at < ms) raw = hit.raw
    else {
      raw = await fetchRaw(a)
      if (raw.status !== 'unavailable') memo.set(a, { at: now, raw })
    }
    return classify(raw, nowMs())
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
    price: cachedSource(60_000, chainlinkRaw(() => getMainnetClient() as unknown as ContractReader)),
    utilization: cachedSource(60_000, utilizationRaw(sql)),
    apr: cachedSource(NET_APY_REUSE_S * 1000, aprRaw(readAprSnapshot)),
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
        r = { status: 'unavailable', source: 'none', reason: 'unsupported subject' }
      }
      out.set(key, r)
    }),
  )
  return out
}
