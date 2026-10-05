/**
 * The request logic behind /api/net-apy, with its data sources injected so it can be
 * tested without a node or the network. Server-side.
 */

import { netBreakdown, type MembraneShareInput, type NetBreakdown } from './breakdown'
import { extractCampaigns, type IncentiveCampaign, type MerklOpportunity } from './incentives'
import { rateSpikeAxis, type RateSpikeAxis } from './ratePath'
import type { SnapshotSet } from './read'
import { redactError } from './rpc'
import type { BlockAnchor } from './types'
import { usdToRaw, venueByKey } from './venues'

/** bigint → decimal string, recursively: the JSON shape the route returns. */
export type Serialized<T> = T extends bigint
  ? string
  : T extends (infer U)[]
    ? Serialized<U>[]
    : T extends readonly (infer U)[]
      ? readonly Serialized<U>[]
      : T extends object
        ? { [K in keyof T]: Serialized<T[K]> }
        : T

export const serialize = <T>(v: T): Serialized<T> =>
  JSON.parse(JSON.stringify(v, (_k, x) => (typeof x === 'bigint' ? x.toString() : x))) as Serialized<T>

export interface IncentivesStatus {
  ok: boolean
  fetchedAt: number | null
  error?: string
}

export interface NetApyDeps {
  snapshots: (block?: bigint) => Promise<SnapshotSet>
  merkl: () => Promise<{ fetchedAt: number; opportunities: MerklOpportunity[] }>
}

export interface NetApyQuery {
  venue?: string
  sizeUsd: number
  side: 'supply' | 'borrow'
  share: MembraneShareInput
  block?: bigint
  /** Include the rate-spike axis (the Risk Frontier hand-off). */
  path: boolean
}

export interface NetApyVenueResponse {
  anchor: BlockAnchor
  rpc: string
  breakdown: NetBreakdown
  rateSpike: RateSpikeAxis | null
  incentivesStatus: IncentivesStatus
}

export interface NetApyListRow {
  venueKey: string
  label: string
  protocol: NetBreakdown['protocol']
  net: NetBreakdown['net']
  netIncentiveFree: NetBreakdown['netIncentiveFree']
  supplyAprNow: number
  borrowAprNow: number
  borrowAprAtKink: number
  firstIncentiveEndTs: number | null
  reverts: string | null
}

export interface NetApyListResponse {
  anchor: BlockAnchor
  rpc: string
  side: 'supply' | 'borrow'
  sizeUsd: number
  venues: NetApyListRow[]
  errors: { venueKey: string; message: string }[]
  incentivesStatus: IncentivesStatus
}

export class QueryError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404,
  ) {
    super(message)
    this.name = 'QueryError'
  }
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

/** Parses and validates the query string. Throws QueryError with the HTTP status. */
export function parseQuery(q: Record<string, string | string[] | undefined>): NetApyQuery {
  const venue = one(q.venue)
  if (venue !== undefined && !venueByKey(venue)) throw new QueryError(`unknown venue '${venue}'`, 404)
  const sizeUsd = one(q.size) === undefined ? 100_000 : Number(one(q.size))
  if (!Number.isFinite(sizeUsd) || sizeUsd < 0 || sizeUsd > 10_000_000_000) throw new QueryError('size must be a USD amount in [0, 1e10]', 400)
  const sideRaw = one(q.side) ?? 'supply'
  if (sideRaw !== 'supply' && sideRaw !== 'borrow') throw new QueryError("side must be 'supply' or 'borrow'", 400)
  const shareOf = (k: string): number | undefined => {
    const v = one(q[k])
    if (v === undefined) return undefined
    const n = Number(v)
    if (!Number.isFinite(n) || n <= 0 || n > 1) throw new QueryError(`${k} must be in (0, 1]; omit it to show "curator-set"`, 400)
    return n
  }
  const blockRaw = one(q.block)
  if (blockRaw !== undefined && !/^\d{1,12}$/.test(blockRaw)) throw new QueryError('block must be a block number', 400)
  return {
    venue,
    sizeUsd,
    side: sideRaw,
    share: { protocolShare: shareOf('protocolShare'), curatorShare: shareOf('curatorShare') },
    block: blockRaw === undefined ? undefined : BigInt(blockRaw),
    path: one(q.path) === '1',
  }
}

async function incentives(deps: NetApyDeps, set: SnapshotSet): Promise<{ campaigns: IncentiveCampaign[]; status: IncentivesStatus }> {
  try {
    const pull = await deps.merkl()
    const vaultOf = (key: string) => {
      const d = venueByKey(key)
      return d && d.protocol === 'euler-v2' ? d.vault : null
    }
    const nowTs = Number(set.anchor.blockTimestamp)
    return { campaigns: extractCampaigns(pull.opportunities, set.snapshots, vaultOf, nowTs), status: { ok: true, fetchedAt: pull.fetchedAt } }
  } catch (e) {
    // No incentive data is shown as "unavailable", never as "no incentives".
    return { campaigns: [], status: { ok: false, fetchedAt: null, error: redactError(e) } }
  }
}

export async function handleNetApy(query: NetApyQuery, deps: NetApyDeps): Promise<NetApyVenueResponse | NetApyListResponse> {
  const set = await deps.snapshots(query.block)
  const { campaigns, status } = await incentives(deps, set)

  if (query.venue) {
    const s = set.snapshots.find((x) => x.venueKey === query.venue)
    if (!s) {
      const err = set.errors.find((e) => e.venueKey === query.venue)
      throw new Error(err ? err.message : `${query.venue}: not read at block ${set.anchor.blockNumber}`)
    }
    const breakdown = netBreakdown(s, { side: query.side, sizeUsd: query.sizeUsd, campaigns, share: query.share })
    const sizeRaw = usdToRaw(query.sizeUsd, s.asset)
    let rateSpike: RateSpikeAxis | null = null
    if (query.path) {
      rateSpike = rateSpikeAxis(s, breakdown.atSize ? { size: query.side === 'supply' ? { supply: sizeRaw, borrow: 0n } : { supply: 0n, borrow: sizeRaw } } : {})
    }
    return { anchor: set.anchor, rpc: set.rpc, breakdown, rateSpike, incentivesStatus: status }
  }

  const venues: NetApyListRow[] = set.snapshots.map((s) => {
    const b = netBreakdown(s, { side: query.side, sizeUsd: query.sizeUsd, campaigns, share: query.share })
    const ends = b.incentives.eligible.map((c) => c.endTs)
    return {
      venueKey: s.venueKey,
      label: s.label,
      protocol: s.protocol,
      net: b.net,
      netIncentiveFree: b.netIncentiveFree,
      supplyAprNow: b.now.supplyApr,
      borrowAprNow: b.now.borrowApr,
      borrowAprAtKink: b.worstCase.borrowAprAtKink,
      firstIncentiveEndTs: ends.length ? Math.min(...ends) : null,
      reverts: b.checks.reverts,
    }
  })
  return { anchor: set.anchor, rpc: set.rpc, side: query.side, sizeUsd: query.sizeUsd, venues, errors: set.errors, incentivesStatus: status }
}
