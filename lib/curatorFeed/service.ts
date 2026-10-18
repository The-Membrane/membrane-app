/**
 * Request handling for /api/curator-feed, minus the I/O. Pure: the route loads the
 * JSON files and passes them in with the clock.
 *
 *   GET /api/curator-feed                       newest actions, open submits, clusters
 *       ?collateral=rsETH|0x…  ?curator=<name or key>  ?protocol=morpho-v1|morpho-v2|euler-earn|aave-v3
 *       ?group=caps|exits|queues|roles|timelock|protocol|all   ?status=open|pending|executable|done
 *       ?window=24..72 (cluster window, hours)  ?limit=1..500  ?before=<action id>
 *   GET /api/curator-feed?view=exposure         collateral → vaults table (head snapshot)
 *       ?by=collateral|vault  ?collateral=  ?curator=  ?minUsd=
 *   GET /api/curator-feed?view=attribution      large vault withdrawals and the market move
 *       ?collateral=  ?market=0x…  ?only=spike|drained
 *   GET /api/curator-feed?view=oracle-gap       oracle vs DefiLlama gap per held market, the
 *       ?collateral=  ?curator=  ?market=0x…  ?limit=   Q25 T2 I3 state and its record
 */

import { attribute, type Attribution } from './attribution'
import { clusteredIds, detectExitClusters, isDirectExit, type ClusterOptions } from './clusters'
import { byCollateral, type CollateralRow } from './exposure'
import {
  FLAG_DEFAULTS,
  isSupplyLocked,
  marketFlagKinds,
  topBorrowerShare,
  utilization,
  vaultBorrowerShare,
  type MarketFlagKind,
} from './flags'
import {
  actionText,
  curatorLabel,
  durationText,
  marketLabel,
  short,
  symbolOf,
  targetLabel,
  utc,
  vaultLabel,
} from './format'
import {
  decodeGapFile,
  evaluateI3,
  PEG_ASSUMED_WITHIN,
  pegOf,
  STALE_HOURS,
  type GapObservation,
  type PegRef,
  type I3Constants,
  type I3Record,
  type I3Result,
  type I3State,
} from './oracleGap'
import { explainSpike, type SpikeExplanation } from './spikes'
import type { ExposureAlloc, MarketFlags, SpikeDriver } from './types'
import { secondsLeft, statusOf, toneOf, type Tone } from './status'
import type { ExposureFile, FeedFile, FeedMeta, OracleGapFile } from './store'
import type { Relation } from '@/lib/exposure/relations'
import type { ClaimClass } from '../netApy/types'
import type { ActionKind, ActionStatus, ExitCluster, FeedAction, Protocol } from './types'

export class QueryError extends Error {}

export type Group = 'caps' | 'exits' | 'queues' | 'roles' | 'timelock' | 'protocol' | 'all'
const GROUPS: Record<Exclude<Group, 'all'>, ActionKind[]> = {
  caps: ['cap_submit', 'cap_raise', 'cap_cut', 'cap_zero', 'cap_revoke'],
  exits: [
    'cap_zero',
    'removal_submit',
    'market_removed',
    'supply_queue_remove',
    'freeze',
    'pause',
    'borrow_off',
    'ltv_zero',
    'writeoff_submit',
    'writeoff',
  ],
  queues: [
    'market_added',
    'market_removed',
    'supply_queue_add',
    'supply_queue_remove',
    'removal_submit',
    'removal_revoke',
  ],
  roles: [
    'curator_set',
    'allocator_set',
    'guardian_submit',
    'guardian_set',
    'guardian_revoke',
    'owner_set',
    'sentinel_set',
    'adapter_add',
    'adapter_remove',
  ],
  timelock: ['timelock_submit', 'timelock_set', 'timelock_revoke', 'v2_submit', 'v2_revoke'],
  protocol: [
    'freeze',
    'unfreeze',
    'pause',
    'unpause',
    'borrow_off',
    'borrow_on',
    'ltv_zero',
    'collateral_params',
  ],
}
const PROTOCOLS: Protocol[] = ['morpho-v1', 'morpho-v2', 'euler-earn', 'aave-v3']

export interface FeedQuery {
  view: 'feed' | 'exposure' | 'attribution' | 'spikes' | 'flags' | 'oracle-gap'
  collateral?: string
  curator?: string
  protocol?: Protocol
  group: Group
  status?: 'open' | 'pending' | 'executable' | 'done'
  windowHours: number
  limit: number
  before?: string
  minUsd: number
  market?: string
  only?: 'spike' | 'drained' | 'reallocation'
  /** exposure view: pivot by collateral (default) or list by vault. */
  by: 'collateral' | 'vault'
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

export function parseFeedQuery(q: Record<string, string | string[] | undefined>): FeedQuery {
  const view = one(q.view) ?? 'feed'
  if (!['feed', 'exposure', 'attribution', 'spikes', 'flags', 'oracle-gap'].includes(view))
    throw new QueryError('view must be feed, exposure, attribution, spikes, flags or oracle-gap')
  const group = (one(q.group) ?? 'all') as Group
  if (group !== 'all' && !(group in GROUPS))
    throw new QueryError(`group must be one of all, ${Object.keys(GROUPS).join(', ')}`)
  const protocol = one(q.protocol) as Protocol | undefined
  if (protocol && !PROTOCOLS.includes(protocol))
    throw new QueryError(`protocol must be one of ${PROTOCOLS.join(', ')}`)
  const status = one(q.status) as FeedQuery['status']
  if (status && !['open', 'pending', 'executable', 'done'].includes(status))
    throw new QueryError('status must be open, pending, executable or done')
  const windowHours = Number(one(q.window) ?? 72)
  if (!Number.isFinite(windowHours) || windowHours < 24 || windowHours > 72)
    throw new QueryError('window must be 24–72 (hours)')
  const limit = Number(one(q.limit) ?? 100)
  if (!Number.isInteger(limit) || limit < 1 || limit > 500)
    throw new QueryError('limit must be an integer 1–500')
  const minUsd = Number(one(q.minUsd) ?? 0)
  if (!Number.isFinite(minUsd) || minUsd < 0) throw new QueryError('minUsd must be ≥ 0')
  const only = one(q.only) as FeedQuery['only']
  if (only && only !== 'spike' && only !== 'drained' && only !== 'reallocation')
    throw new QueryError('only must be spike, drained or reallocation')
  const by = (one(q.by) ?? 'collateral') as FeedQuery['by']
  if (by !== 'collateral' && by !== 'vault') throw new QueryError('by must be collateral or vault')
  const market = one(q.market)?.toLowerCase()
  if (market && !/^0x[0-9a-f]{64}$/.test(market))
    throw new QueryError('market must be a 32-byte Morpho market id')
  return {
    view: view as FeedQuery['view'],
    collateral: one(q.collateral)?.trim() || undefined,
    curator: one(q.curator)?.trim() || undefined,
    protocol,
    group,
    status,
    windowHours,
    limit,
    before: one(q.before),
    minUsd,
    market,
    only,
    by,
  }
}

/** collateral filter: an address, or a symbol (case-insensitive, exact). */
export function collateralMatcher(
  feed: Pick<FeedFile, 'entities'>,
  needle: string | undefined,
): (addrs: string[]) => boolean {
  if (!needle) return () => true
  const n = needle.toLowerCase()
  if (/^0x[0-9a-f]{40}$/.test(n)) return (addrs) => addrs.some((a) => a.toLowerCase() === n)
  const hits = new Set(
    Object.entries(feed.entities.tokens)
      .filter(([, t]) => t.symbol.toLowerCase() === n)
      .map(([a]) => a),
  )
  return (addrs) => addrs.some((a) => hits.has(a.toLowerCase()))
}

export function curatorMatcher(
  feed: Pick<FeedFile, 'entities'>,
  needle: string | undefined,
): (vault: string) => boolean {
  if (!needle) return () => true
  const n = needle.toLowerCase()
  return (vault) => {
    const v = feed.entities.vaults[vault]
    const key = v?.curatorKey ?? (feed.entities.aaveMarkets[vault] ? `aave:${vault}` : vault)
    const name = feed.entities.curators[key]?.name ?? feed.entities.aaveMarkets[vault] ?? ''
    return key.toLowerCase() === n || name.toLowerCase().includes(n)
  }
}

export const curatorKeyOf =
  (feed: Pick<FeedFile, 'entities'>) =>
  (vault: string): string =>
    feed.entities.vaults[vault]?.curatorKey ??
    (feed.entities.aaveMarkets[vault] ? `aave:${vault}` : vault)

/**
 * Umbrella claim classes (lib/netApy/types.ts ClaimClass): a feed row is a change the
 * chain recorded; a cluster is a possible leading signal (a pattern, not an outcome);
 * an attribution row is an observed driver of one block's market move.
 */
export const CLAIM = {
  row: 'measured-change',
  cluster: 'possible-leading-signal',
  attribution: 'observed-driver',
  spike: 'observed-driver',
  /** An oracle's inputs or state, or a market's largest borrower, read at a block. */
  marketFlag: 'measured-change',
  /** One curator moving a position between its own vaults, then cutting it. */
  shift: 'possible-leading-signal',
  /** Oracle above its market price for 24 h (Q25 T2 I3): a pattern, scored on n = 3. */
  oracleGap: 'possible-leading-signal',
} as const satisfies Record<string, ClaimClass>

/**
 * Functions a vault's curator can run in one transaction (timelock 0 at the last read):
 * V1 / Euler Earn `timelock` = 0 covers cap raises, removals and guardian changes; Vault V2
 * reports per function (types.ts VaultInfo.timelocks).
 */
export function zeroTimelockFns(feed: Pick<FeedFile, 'entities'>, vault: string): string[] {
  const v = feed.entities.vaults[vault]
  if (!v) return []
  if (v.timelocks)
    return Object.entries(v.timelocks)
      .filter(([, s]) => s === 0)
      .map(([f]) => f)
  return v.timelock === 0 ? ['timelock'] : []
}

export interface FeedRow extends FeedAction {
  claim: typeof CLAIM.row
  status: ActionStatus
  tone: Tone
  /** Seconds left in the timelock window (open submits only). */
  secondsLeft: number
  inCluster: boolean
  text: string
  vaultName: string
  curatorName: string
  targetName: string
  collateralSymbols: string[]
  /** Functions this vault's curator can run with no timelock (see zeroTimelockFns). */
  zeroTimelock: string[]
}

export interface ClusterView extends ExitCluster {
  claim: typeof CLAIM.cluster
  /** Member vaults that closed caps on ≥ 3 different collaterals inside the cluster's
   *  window — a wind-down or broad cut, as opposed to a single-asset exit. */
  broadVaults: number
  symbol: string
  curatorNames: string[]
  vaultNames: string[]
  /** "3 curators set rsETH caps to 0 or removed rsETH markets within 19h" */
  text: string
}

export interface FeedResponse {
  meta: Pick<
    FeedMeta,
    | 'fromBlock'
    | 'toBlock'
    | 'fromTs'
    | 'toTs'
    | 'collectedAt'
    | 'thresholds'
    | 'lastRun'
    | 'caveats'
    | 'sources'
  > & { now: number; logs: FeedMeta['logs'] }
  /** Every open submit (pending or executable) that passes the filters — never paged. */
  open: FeedRow[]
  rows: FeedRow[]
  clusters: ClusterView[]
  nextBefore?: string
  total: number
}

const DONE: ReadonlySet<ActionStatus> = new Set(['accepted', 'revoked', 'cleared', 'executed'])

export function decorate(
  feed: FeedFile,
  a: FeedAction,
  nowS: number,
  clustered: Set<string>,
): FeedRow {
  const status = statusOf(a, nowS)
  const inCluster = clustered.has(a.id)
  return {
    ...a,
    claim: CLAIM.row,
    status,
    tone: toneOf(status, inCluster),
    secondsLeft: secondsLeft(a, nowS),
    inCluster,
    text: actionText(feed.entities, a),
    vaultName: vaultLabel(feed.entities, a.vault),
    curatorName: curatorLabel(feed.entities, a.vault),
    targetName: targetLabel(feed.entities, a),
    collateralSymbols: a.collateral.map((c) => symbolOf(feed.entities, c)),
    zeroTimelock: zeroTimelockFns(feed, a.vault),
  }
}

/** Factual cluster sentence. `unread` = member exits whose remaining caps were not read;
 *  `broad` = [vaults that closed caps on ≥ 3 collaterals in the window, member vaults]. */
export function clusterText(
  n: number,
  symbol: string,
  hours: number,
  unread = 0,
  broad?: [number, number],
): string {
  const h = hours < 1 ? '<1h' : `${Math.round(hours)}h`
  const tail = unread ? ` (${unread} exit${unread > 1 ? 's' : ''}: remaining caps not read)` : ''
  const wide =
    broad && broad[0] > 0
      ? `; ${broad[0]} of ${broad[1]} vaults closed caps on 3 or more collaterals in the same window`
      : ''
  return `${n} curators set ${symbol} caps to 0 or removed ${symbol} markets, leaving no other ${symbol} market capped, within ${h}${tail}${wide}`
}

/** Vaults among `vaults` that exited ≥ 3 distinct collaterals between `from` and `to`. */
export function broadExitVaults(
  actions: FeedAction[],
  vaults: string[],
  from: number,
  to: number,
): number {
  const set = new Set(vaults)
  const coll = new Map<string, Set<string>>()
  for (const a of actions) {
    if (!set.has(a.vault) || a.ts < from || a.ts > to || !isDirectExit(a)) continue
    const s = coll.get(a.vault) ?? new Set<string>()
    s.add(a.collateral[0])
    coll.set(a.vault, s)
  }
  return [...coll.values()].filter((s) => s.size >= 3).length
}

export const expiryOf =
  (feed: Pick<FeedFile, 'entities'>) =>
  (token: string): number | undefined =>
    feed.entities.tokens[token.toLowerCase()]?.expiry

export function buildClusters(feed: FeedFile, opts: ClusterOptions): ClusterView[] {
  const curatorOf = curatorKeyOf(feed)
  const byId = new Map(feed.actions.map((a) => [a.id, a]))
  return detectExitClusters(feed.actions, curatorOf, { expiryOf: expiryOf(feed), ...opts }).map(
    (c) => {
      const symbol = symbolOf(feed.entities, c.collateral)
      const W = opts.windowHours * 3600
      const broadVaults = broadExitVaults(feed.actions, c.vaults, c.start - W, c.end + W)
      return {
        ...c,
        claim: CLAIM.cluster,
        broadVaults,
        symbol,
        curatorNames: c.curators.map((k) => feed.entities.curators[k]?.name ?? k),
        vaultNames: c.vaults.map((v) => vaultLabel(feed.entities, v)),
        text: clusterText(
          c.curators.length,
          symbol,
          c.tightestHours,
          c.actionIds.filter((id) => byId.get(id)?.stillCapped === undefined).length,
          [broadVaults, c.vaults.length],
        ),
      }
    },
  )
}

/** Kinds whose rows can repeat to the reader: a cap or an exit on one target. */
const SAME_ROW_KINDS = new Set<ActionKind>([...GROUPS.caps, ...GROUPS.exits])

/**
 * One row per kind + vault + target (market or collateral) + UTC day + status, for the cap
 * and exit kinds. A Morpho V2 vault cuts a market's absolute and its relative cap to 0 in
 * one transaction: two actions, one change to the reader, and the card printed "Cap cut to
 * 0: PT-sUSDD-27AUG2026 · Gauntlet USDC Frontier · 2026-10-09" twice. The first in list
 * order (newest first) stays. Other kinds, and an action with no target, are never merged.
 */
export function dedupeSameRows<T>(
  list: readonly T[],
  actionOf: (x: T) => FeedAction,
  statusOfX: (x: T) => ActionStatus,
): T[] {
  const seen = new Set<string>()
  return list.filter((x) => {
    const a = actionOf(x)
    if (!SAME_ROW_KINDS.has(a.kind) || !a.target) return true
    const day = new Date(a.ts * 1000).toISOString().slice(0, 10)
    const key = [a.kind, a.vault, a.target, day, statusOfX(x)].join('|')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function buildFeedResponse(feed: FeedFile, q: FeedQuery, nowS: number): FeedResponse {
  const clusters = buildClusters(feed, { windowHours: q.windowHours, minCurators: 2 })
  const clustered = clusteredIds(clusters)
  const coll = collateralMatcher(feed, q.collateral)
  const cur = curatorMatcher(feed, q.curator)
  const kinds = q.group === 'all' ? null : new Set(GROUPS[q.group])
  const pass = (a: FeedAction) =>
    (!q.protocol || a.protocol === q.protocol) &&
    (!kinds || kinds.has(a.kind)) &&
    coll(a.collateral) &&
    cur(a.vault)
  // Status is cheap and needed for every row (filters, the open list); the sentence and
  // labels are rendered only for the rows this response returns.
  const all = dedupeSameRows(
    feed.actions
      .filter(pass)
      .map((a) => ({ a, status: statusOf(a, nowS) }))
      .sort((x, y) => y.a.block - x.a.block || y.a.id.localeCompare(x.a.id)),
    (x) => x.a,
    (x) => x.status,
  )
  const statusOk = (s: ActionStatus) =>
    !q.status ||
    (q.status === 'open'
      ? s === 'pending' || s === 'executable'
      : q.status === 'done'
        ? DONE.has(s)
        : s === q.status)
  const filtered = all.filter((x) => statusOk(x.status))
  let start = 0
  if (q.before) {
    const i = filtered.findIndex((x) => x.a.id === q.before)
    if (i < 0) throw new QueryError('before: unknown action id')
    start = i + 1
  }
  const rows = filtered
    .slice(start, start + q.limit)
    .map((x) => decorate(feed, x.a, nowS, clustered))
  return {
    meta: {
      fromBlock: feed.meta.fromBlock,
      toBlock: feed.meta.toBlock,
      fromTs: feed.meta.fromTs,
      toTs: feed.meta.toTs,
      collectedAt: feed.meta.collectedAt,
      thresholds: feed.meta.thresholds,
      lastRun: feed.meta.lastRun,
      caveats: feed.meta.caveats,
      sources: feed.meta.sources,
      logs: feed.meta.logs,
      now: nowS,
    },
    open: all
      .filter((x) => x.status === 'pending' || x.status === 'executable')
      .map((x) => decorate(feed, x.a, nowS, clustered))
      .sort((a, b) => (a.validAt ?? 0) - (b.validAt ?? 0)),
    rows,
    clusters: clusters.filter((c) => coll([c.collateral]) && c.vaults.some(cur)),
    nextBefore: start + q.limit < filtered.length ? rows[rows.length - 1]?.id : undefined,
    total: filtered.length,
  }
}

// ── exposure ───────────────────────────────────────────────────────────────────

export interface ExposureHolderView {
  vault: string
  vaultName: string
  curator: string
  curatorName: string
  protocol: Protocol
  loanSymbol: string
  /** Whole loan-token units. */
  amount: number
  usd?: number
  /** Part of `usd` in markets whose supply is locked (book value, flags.ts flag 5). */
  lockedUsd?: number
  shareOfVault: number
}
export interface ExposureRowView {
  collateral: string
  symbol: string
  /** Live supply: book value in supply-locked markets excluded. */
  usd: number
  /** Book value: supply in markets whose supply is locked. */
  lockedUsd: number
  unpriced: number
  curatorCount: number
  holders: ExposureHolderView[]
}
export interface ExposureResponse {
  block: number
  ts: number
  rows: ExposureRowView[]
}

export function buildExposureResponse(
  feed: FeedFile,
  exposure: ExposureFile,
  q: FeedQuery,
): ExposureResponse {
  const curatorOf = curatorKeyOf(feed)
  const loanOf = (vault: string) => feed.entities.vaults[vault]?.asset ?? ''
  const cur = curatorMatcher(feed, q.curator)
  const coll = collateralMatcher(feed, q.collateral)
  const rows: CollateralRow[] = byCollateral(
    exposure.vaults.filter((v) => cur(v.vault)),
    curatorOf,
    loanOf,
    { isLocked: (t) => isLockedMarket(feed, t) },
  )
  return {
    block: exposure.block,
    ts: exposure.ts,
    rows: rows
      .filter((r) => coll([r.collateral]) && Math.max(r.usd, r.lockedUsd) >= q.minUsd)
      .map((r) => ({
        collateral: r.collateral,
        symbol: symbolOf(feed.entities, r.collateral),
        usd: r.usd,
        lockedUsd: r.lockedUsd,
        unpriced: r.unpriced,
        curatorCount: r.curators.length,
        holders: r.holders.map((h) => {
          const dec = feed.entities.tokens[h.loan]?.decimals ?? 18
          return {
            vault: h.vault,
            vaultName: vaultLabel(feed.entities, h.vault),
            curator: h.curator,
            curatorName: feed.entities.curators[h.curator]?.name ?? h.curator,
            protocol: h.protocol,
            loanSymbol: symbolOf(feed.entities, h.loan),
            amount: Number(BigInt(h.assets)) / 10 ** dec,
            usd: h.usd,
            ...(h.lockedUsd !== undefined ? { lockedUsd: h.lockedUsd } : {}),
            shareOfVault: h.shareOfVault,
          }
        }),
      })),
  }
}

// ── attribution ────────────────────────────────────────────────────────────────

export interface AttributionView {
  claim: typeof CLAIM.attribution
  market: string
  marketName: string
  collateralSymbol: string
  loanSymbol: string
  block: number
  ts: number
  tx: string
  /** Whole loan-token units. */
  withdrawn: number
  supplyBefore: number
  supplyAfter: number
  shareOfDrop?: number
  utilBefore: number
  utilAfter: number
  aprBefore?: number
  aprAfter?: number
  spike: boolean
  drained: boolean
  vaults: {
    vault: string
    vaultName: string
    curatorName: string
    amount: number
    source: string
  }[]
  text: string
}

export function attributionText(
  v: Omit<AttributionView, 'text' | 'claim'>,
  fmt: (n: number) => string,
): string {
  const who =
    v.vaults.length === 1
      ? `${v.vaults[0].vaultName} (${v.vaults[0].curatorName})`
      : `${v.vaults.length} vaults`
  const share =
    v.shareOfDrop !== undefined
      ? ` — ${(v.shareOfDrop * 100).toFixed(0)}% of the block's supply drop`
      : ''
  const rate =
    v.aprBefore !== undefined && v.aprAfter !== undefined
      ? `; borrow APR ${(v.aprBefore * 100).toFixed(2)}% → ${(v.aprAfter * 100).toFixed(2)}%`
      : ''
  return `${who} withdrew ${fmt(v.withdrawn)} ${v.loanSymbol} from ${v.marketName} in block ${v.block}${share}; utilization ${(v.utilBefore * 100).toFixed(1)}% → ${(v.utilAfter * 100).toFixed(1)}%${rate}`
}

export function buildAttributionResponse(
  feed: FeedFile,
  q: FeedQuery,
  fmt: (n: number) => string,
): AttributionView[] {
  const coll = collateralMatcher(feed, q.collateral)
  const out: AttributionView[] = []
  for (const c of feed.attribution) {
    if (q.market && c.market !== q.market) continue
    const m = feed.entities.markets[c.market]
    if (!m || !coll([m.collateral])) continue
    const a: Attribution | null = attribute(c)
    if (!a) continue
    if (q.only === 'spike' && !a.spike) continue
    if (q.only === 'drained' && !a.drained) continue
    const dec = feed.entities.tokens[m.loan.toLowerCase()]?.decimals ?? 18
    const u = (x: bigint | string) => Number(BigInt(x)) / 10 ** dec
    const base: Omit<AttributionView, 'text' | 'claim'> = {
      market: c.market,
      marketName: marketLabel(feed.entities, c.market),
      collateralSymbol: symbolOf(feed.entities, m.collateral),
      loanSymbol: symbolOf(feed.entities, m.loan),
      block: c.block,
      ts: c.ts,
      tx: c.legs[0]?.tx ?? '',
      withdrawn: u(a.withdrawn),
      supplyBefore: u(a.supplyBefore),
      supplyAfter: u(a.supplyAfter),
      shareOfDrop: a.shareOfDrop,
      utilBefore: a.utilBefore,
      utilAfter: a.utilAfter,
      aprBefore: a.aprBefore,
      aprAfter: a.aprAfter,
      spike: a.spike,
      drained: a.drained,
      vaults: c.legs.map((l) => ({
        vault: l.vault,
        vaultName: vaultLabel(feed.entities, l.vault),
        curatorName: curatorLabel(feed.entities, l.vault),
        amount: u(l.assets),
        source: l.source,
      })),
    }
    out.push({ ...base, claim: CLAIM.attribution, text: attributionText(base, fmt) })
  }
  return out.sort((a, b) => b.block - a.block)
}

// ── exposure, by vault ─────────────────────────────────────────────────────────

export interface VaultAllocView {
  target: string
  targetName: string
  collateralSymbols: string[]
  /** Whole loan-token units. */
  amount: number
  usd?: number
  share: number
  via?: string
  /** Short labels of the market's flags (flags.ts), e.g. "oracle reverting". */
  flags?: string[]
  /** The market's supply is locked (flags.ts flag 5): `usd` is book value. */
  locked?: boolean
}
export interface VaultExposureView {
  vault: string
  vaultName: string
  curatorName: string
  protocol: Protocol
  loanSymbol: string
  /** totalAssets() as the vault reports it, USD. */
  totalUsd?: number
  /** Of `totalUsd`: allocations in supply-locked markets (book value). */
  lockedUsd?: number
  /** Of `totalUsd`: MetaMorpho v1.1 lostAssets(), written off but still counted. */
  lostUsd?: number
  /** `totalUsd` less `lockedUsd` and `lostUsd`. */
  liveUsd?: number
  /** Seconds per function from the last read (V1 / Euler Earn: `timelock`). */
  timelocks: Record<string, number>
  zeroTimelock: string[]
  allocations: VaultAllocView[]
}

/** vault → markets / strategies → collateral → share of the vault. Largest live supply
 *  first (`minUsd` filters on the reported total, so a vault of book value stays listed). */
export function buildVaultExposure(
  feed: FeedFile,
  exposure: ExposureFile,
  q: FeedQuery,
): { block: number; ts: number; vaults: VaultExposureView[] } {
  const cur = curatorMatcher(feed, q.curator)
  const coll = collateralMatcher(feed, q.collateral)
  const label = (a: ExposureAlloc): string =>
    a.scope === 'strategy'
      ? targetLabel(feed.entities, { scope: 'strategy', target: a.target, protocol: 'euler-earn' })
      : feed.entities.markets[a.target]
        ? marketLabel(feed.entities, a.target)
        : `vault ${vaultLabel(feed.entities, a.target)}`
  const vaults = exposure.vaults
    .filter(
      (v) =>
        cur(v.vault) &&
        (v.totalUsd ?? 0) >= q.minUsd &&
        (!q.collateral || v.allocations.some((a) => coll(a.collateral))),
    )
    .map((v) => {
      const asset = feed.entities.vaults[v.vault]?.asset ?? ''
      const dec = feed.entities.tokens[asset]?.decimals ?? 18
      const price = feed.entities.tokens[asset]?.priceUsd
      const lostRaw =
        v.lostAssets && price !== undefined
          ? (Number(BigInt(v.lostAssets)) / 10 ** dec) * price
          : undefined
      // Under $1 is rounding left by share math, not a write-off.
      const lost = lostRaw !== undefined && lostRaw >= 1 ? lostRaw : undefined
      // An allocation's book value can exceed what the vault reports (a Vault V2 adapter's
      // expectedSupplyAssets accrues to now; the vault's totalAssets grows at most at its
      // max rate). The vault-level figure is the part of its reported total.
      const lockedAll = v.allocations
        .filter((a) => isLockedMarket(feed, a.target))
        .reduce((s, a) => s + (a.usd ?? 0), 0)
      const locked =
        v.totalUsd !== undefined
          ? Math.min(lockedAll, Math.max(0, v.totalUsd - (lost ?? 0)))
          : lockedAll
      return {
        vault: v.vault,
        vaultName: vaultLabel(feed.entities, v.vault),
        curatorName: curatorLabel(feed.entities, v.vault),
        protocol: v.protocol,
        loanSymbol: symbolOf(feed.entities, asset),
        totalUsd: v.totalUsd,
        ...(locked > 0 ? { lockedUsd: locked } : {}),
        ...(lost !== undefined ? { lostUsd: lost } : {}),
        liveUsd:
          v.totalUsd !== undefined ? Math.max(0, v.totalUsd - locked - (lost ?? 0)) : undefined,
        timelocks:
          feed.entities.vaults[v.vault]?.timelocks ??
          (feed.entities.vaults[v.vault]?.timelock !== undefined
            ? { timelock: feed.entities.vaults[v.vault]!.timelock! }
            : {}),
        zeroTimelock: zeroTimelockFns(feed, v.vault),
        allocations: v.allocations.map((a) => ({
          target: a.target,
          targetName: label(a),
          collateralSymbols: a.collateral.map((c) => symbolOf(feed.entities, c)),
          amount: Number(BigInt(a.assets)) / 10 ** dec,
          usd: a.usd,
          share: a.share,
          via: a.via,
          flags: allocFlagLabels(feed, a.target, a.share),
          ...(isLockedMarket(feed, a.target) ? { locked: true } : {}),
        })),
      }
    })
    .sort((a, b) => (b.liveUsd ?? 0) - (a.liveUsd ?? 0) || (b.totalUsd ?? 0) - (a.totalUsd ?? 0))
  return { block: exposure.block, ts: exposure.ts, vaults }
}

// ── rate spikes ────────────────────────────────────────────────────────────────

export interface SpikeDriverView {
  driver: SpikeDriver
  vault?: string
  vaultName?: string
  curatorName?: string
  source?: string
  /** Whole loan-token units. */
  amount: number
  /** First-order utilization change (+ = up) and share of the upward push (0–1). */
  du: number
  share: number
  tx: string
}
export interface SpikeView {
  claim: typeof CLAIM.spike
  market: string
  marketName: string
  collateralSymbol: string
  loanSymbol: string
  block: number
  ts: number
  aprBefore: number
  aprAfter: number
  utilBefore?: number
  utilAfter?: number
  /** Market supply before the block, whole loan-token units, and in USD at collection-time prices. */
  supply?: number
  supplyUsd?: number
  top?: SpikeDriver
  topShare?: number
  reallocationShare: number
  drivers: SpikeDriverView[]
  text: string
}

const pct1 = (x: number) => `${(x * 100).toFixed(1)}%`
const pct2 = (x: number) => `${(x * 100).toFixed(2)}%`

/** One factual phrase per driver row. */
export function driverText(d: SpikeDriverView, loan: string, fmt: (n: number) => string): string {
  const amt = `${fmt(d.amount)} ${loan}`
  const who = d.vaultName ? `${d.vaultName}${d.curatorName ? ` (${d.curatorName})` : ''}` : ''
  switch (d.driver) {
    case 'vault-reallocation':
      return `${who} reallocated ${amt} out${d.source === 'public-allocator' ? ' through the Public Allocator' : ''}`
    case 'vault-redemption':
      return `${who} withdrew ${amt} to pay its depositors`
    case 'vault-deposit':
      return `${who} supplied ${amt}`
    case 'supplier-withdrawal':
      return `suppliers outside vaults withdrew ${amt}`
    case 'supplier-deposit':
      return `suppliers outside vaults supplied ${amt}`
    case 'borrow':
      return `new borrows of ${amt}`
    case 'repay':
      return `repayments of ${amt}`
    case 'liquidation':
      return `liquidations repaid ${amt}`
    case 'bad-debt':
      return `bad debt of ${amt} written off`
  }
}

export function spikeText(
  v: Omit<SpikeView, 'text' | 'claim'>,
  fmt: (n: number) => string,
): string {
  const util =
    v.utilBefore !== undefined && v.utilAfter !== undefined
      ? `; utilization ${pct1(v.utilBefore)} → ${pct1(v.utilAfter)}`
      : ''
  const pushers = v.drivers.filter((d) => d.share > 0).slice(0, 3)
  const why = pushers.length
    ? `. Utilization rose with: ${pushers.map((d) => `${driverText(d, v.loanSymbol, fmt)} (≈ ${Math.round(d.share * 100)}%)`).join('; ')}`
    : v.utilBefore === undefined
      ? '. Market state before the block not read'
      : '. No supply or borrow change in the block pushed utilization up (the rate moved with time at high utilization)'
  return `Borrow APR on ${v.marketName} went ${pct2(v.aprBefore)} → ${pct2(v.aprAfter)} after block ${v.block}${util}${why}`
}

/**
 * Rate spikes, newest first. `minUsd` filters on market supply before the block (USD);
 * `limit` caps the rows returned, `total` counts every row that matched.
 */
export function buildSpikeResponse(
  feed: FeedFile,
  q: FeedQuery,
  fmt: (n: number) => string,
): { rows: SpikeView[]; total: number } {
  const coll = collateralMatcher(feed, q.collateral)
  const cur = curatorMatcher(feed, q.curator)
  const out: SpikeView[] = []
  for (const c of feed.spikes) {
    if (q.market && c.market !== q.market) continue
    const m = feed.entities.markets[c.market]
    if (!m || !coll([m.collateral])) continue
    const e: SpikeExplanation = explainSpike(c)
    if (q.only === 'reallocation' && e.top !== 'vault-reallocation') continue
    if (q.only === 'drained' && (e.utilAfter ?? 0) < 0.99) continue
    if (q.curator && !e.contributions.some((x) => x.vault && cur(x.vault))) continue
    const loanToken = feed.entities.tokens[m.loan.toLowerCase()]
    const dec = loanToken?.decimals ?? 18
    const u = (x: bigint | string) => Number(BigInt(x)) / 10 ** dec
    const supply = e.supplyBefore !== undefined ? u(e.supplyBefore) : undefined
    const supplyUsd =
      supply !== undefined && loanToken?.priceUsd ? supply * loanToken.priceUsd : undefined
    if (q.minUsd > 0 && (supplyUsd ?? 0) < q.minUsd) continue
    const drivers: SpikeDriverView[] = e.contributions.map((x) => ({
      driver: x.driver,
      vault: x.vault,
      vaultName: x.vault ? vaultLabel(feed.entities, x.vault) : undefined,
      curatorName: x.vault ? curatorLabel(feed.entities, x.vault) : undefined,
      source: x.source,
      amount: u(x.assets),
      du: x.du,
      share: x.share,
      tx: x.tx,
    }))
    const base: Omit<SpikeView, 'text' | 'claim'> = {
      market: c.market,
      marketName: marketLabel(feed.entities, c.market),
      collateralSymbol: symbolOf(feed.entities, m.collateral),
      loanSymbol: symbolOf(feed.entities, m.loan),
      block: c.block,
      ts: c.ts,
      aprBefore: e.aprBefore,
      aprAfter: e.aprAfter,
      utilBefore: e.utilBefore,
      utilAfter: e.utilAfter,
      supply,
      supplyUsd,
      top: e.top,
      topShare: e.topShare,
      reallocationShare: e.reallocationShare,
      drivers,
    }
    out.push({ ...base, claim: CLAIM.spike, text: spikeText(base, fmt) })
  }
  out.sort((a, b) => b.block - a.block)
  return { rows: out.slice(0, q.limit), total: out.length }
}

// ── flags (lib/curatorFeed/flags.ts) ──────────────────────────────────────────

const FLAG_LABEL: Record<MarketFlagKind, string> = {
  'oracle-fixed': 'fixed-price oracle',
  'oracle-reported': 'reported-value oracle',
  'oracle-reverting': 'oracle reverting',
  'oracle-stale': 'oracle stale',
  'one-borrower': 'one borrower',
  'supply-locked': 'supply locked (book value)',
}

const pct0 = (x: number) => `${Math.round(x * 100)}%`

/** USD of the market's borrows as read with its largest borrower. */
function borrowUsdOf(feed: FeedFile, market: string, f: MarketFlags): number | undefined {
  const m = feed.entities.markets[market]
  const t = m ? feed.entities.tokens[m.loan.toLowerCase()] : undefined
  if (!f.borrowers || !t?.priceUsd) return undefined
  return (Number(BigInt(f.borrowers.totalBorrow)) / 10 ** t.decimals) * t.priceUsd
}

export function marketFlagKindsOf(feed: FeedFile, market: string): MarketFlagKind[] {
  const f = feed.flags?.markets[market]
  return f ? marketFlagKinds(f, borrowUsdOf(feed, market, f)) : []
}

/** Flag 5: supply in this market is book value. */
export function isLockedMarket(feed: FeedFile, market: string): boolean {
  const f = feed.flags?.markets[market]
  return f ? isSupplyLocked(f) : false
}

/** Labels for one vault allocation; the one-borrower label carries the vault's part. */
function allocFlagLabels(feed: FeedFile, market: string, allocShare: number): string[] | undefined {
  const f = feed.flags?.markets[market]
  if (!f) return undefined
  const kinds = marketFlagKindsOf(feed, market)
  const out = kinds.filter((k) => k !== 'one-borrower').map((k) => FLAG_LABEL[k])
  if (kinds.includes('one-borrower')) {
    const v = vaultBorrowerShare(allocShare, f)
    out.push(
      v !== undefined && v >= 0.005
        ? `one borrower ≈ ${pct0(v)} of vault`
        : `one borrower (${pct0(topBorrowerShare(f) ?? 0)} of market)`,
    )
  }
  return out.length ? out : undefined
}

/** 1 collateral unit in loan units, from a 1e36-scaled oracle price. */
function unitPrice(price: string, collDec: number, loanDec: number): number {
  return (Number(BigInt(price)) / 1e36) * 10 ** (collDec - loanDec)
}

/** One factual sentence per flag. */
export function marketFlagTexts(
  feed: FeedFile,
  market: string,
  f: MarketFlags,
  kinds: MarketFlagKind[],
  fmt: (n: number) => string,
): string[] {
  const e = feed.entities
  const m = e.markets[market]
  const coll = symbolOf(e, m.collateral)
  const loan = symbolOf(e, m.loan)
  const cd = e.tokens[m.collateral.toLowerCase()]?.decimals ?? 18
  const ld = e.tokens[m.loan.toLowerCase()]?.decimals ?? 18
  const lltv = pct0(Number(BigInt(m.lltv)) / 1e18)
  const out: string[] = []
  if (kinds.includes('oracle-fixed'))
    out.push(
      `The oracle has no price feed: it prices 1 ${coll} at ${f.price ? fmt(unitPrice(f.price, cd, ld)) : 'a constant'} ${loan} at every block. A fall in ${coll}'s market price does not reach this market; only accrued interest can push a position past its ${lltv} liquidation LTV.`,
    )
  if (kinds.includes('oracle-reported')) {
    const inputs = f.parts.map((p) =>
      p.role.endsWith('Vault')
        ? `the ${symbolOf(e, p.address)} vault rate (1 ${symbolOf(e, p.asset ?? '')} taken as 1 ${loan})`
        : `"${p.description}"`,
    )
    out.push(
      `The oracle prices ${coll} from ${inputs.join(' and ')}: reported values, with no market price in the path. A fall in ${coll}'s market price does not reach this market.`,
    )
  }
  if (kinds.includes('oracle-reverting') && f.reverting)
    out.push(
      `${f.reverting.beforeWindow ? `price() reverts at every block probed back to block ${f.reverting.since.toLocaleString('en-US')} (${utc(f.reverting.sinceTs)})` : `price() has reverted since block ${f.reverting.since.toLocaleString('en-US')} (${utc(f.reverting.sinceTs)})`}: liquidations, new borrows and collateral withdrawals from positions with debt revert in this market. Repaying is the only way a borrower can leave.`,
    )
  if (kinds.includes('oracle-stale') && f.staleSeconds !== undefined)
    out.push(
      `An oracle feed's latestRoundData() reports its last update ${durationText(f.staleSeconds)} before block ${(feed.flags?.block ?? 0).toLocaleString('en-US')}.`,
    )
  if (kinds.includes('one-borrower') && f.borrowers) {
    const total = Number(BigInt(f.borrowers.totalBorrow)) / 10 ** ld
    out.push(
      `One address (${short(f.borrowers.top)}) owes ${pct0(topBorrowerShare(f) ?? 0)} of the market's ${fmt(total)} ${loan} of borrows (block ${f.borrowers.block.toLocaleString('en-US')}).`,
    )
  }
  if (kinds.includes('supply-locked') && f.fill) {
    const x = f.fill
    const u = (v: string) => Number(BigInt(v)) / 10 ** ld
    out.push(
      `Borrows are ${pct1(utilization(x.supply, x.borrow) ?? 0)} of supply at block ${x.block.toLocaleString('en-US')} and were ${pct1(utilization(x.prevSupply, x.prevBorrow) ?? 0)} at block ${x.prevBlock.toLocaleString('en-US')} (${utc(x.prevTs)}), and the oracle ${f.reverting ? 'reverts' : 'has no market price'}. Suppliers can withdraw only what borrowers repay. market() shows ${fmt(u(x.supply))} ${loan} of supply with interest accrued to ${utc(x.lastUpdate)}; interest adds to it at the borrow rate. This feed counts supply here as book value, apart from live supply.`,
    )
  }
  return out
}

export interface MarketFlagView {
  claim: typeof CLAIM.marketFlag
  market: string
  marketName: string
  collateralSymbol: string
  loanSymbol: string
  oracle: string
  kinds: MarketFlagKind[]
  /** What curated vaults supply to it at the last exposure read, USD. */
  curatedUsd?: number
  vaults: {
    vault: string
    vaultName: string
    curatorName: string
    /** Part of the vault in this market (0–1). */
    share: number
    usd?: number
    /** Part of the vault lent to the market's largest borrower (0–1). */
    borrowerShare?: number
  }[]
  texts: string[]
}

export interface ShiftView {
  claim: typeof CLAIM.shift
  curatorName: string
  market: string
  marketName: string
  day: string
  usd?: number
  from: { vault: string; vaultName: string; amount: number }[]
  to: { vault: string; vaultName: string; amount: number }[]
  cuts: { vault: string; vaultName: string; ts: number; kind: string }[]
  text: string
}

const CUT_TEXT: Record<string, string> = {
  cap_zero: 'set its cap to 0',
  removal_submit: "submitted the market's removal",
  market_removed: 'removed the market',
  writeoff_submit: 'submitted a write-off',
  writeoff: 'wrote the position off',
}

export function buildFlagsResponse(
  feed: FeedFile,
  exposure: ExposureFile,
  q: FeedQuery,
  fmt: (n: number) => string,
): { block?: number; ts?: number; markets: MarketFlagView[]; shifts: ShiftView[] } {
  const flags = feed.flags
  if (!flags) return { markets: [], shifts: [] }
  const e = feed.entities
  const coll = collateralMatcher(feed, q.collateral)
  const cur = curatorMatcher(feed, q.curator)
  const holders = new Map<string, MarketFlagView['vaults']>()
  for (const v of exposure.vaults)
    for (const a of v.allocations) {
      if (!flags.markets[a.target]) continue
      const f = flags.markets[a.target]
      holders.set(a.target, [
        ...(holders.get(a.target) ?? []),
        {
          vault: v.vault,
          vaultName: vaultLabel(e, v.vault),
          curatorName: curatorLabel(e, v.vault),
          share: a.share,
          usd: a.usd,
          borrowerShare: vaultBorrowerShare(a.share, f),
        },
      ])
    }
  const markets: MarketFlagView[] = []
  for (const [market, f] of Object.entries(flags.markets)) {
    const m = e.markets[market]
    if (!m || (q.market && market !== q.market) || !coll([m.collateral])) continue
    const vs = (holders.get(market) ?? []).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
    if (q.curator && !vs.some((v) => cur(v.vault))) continue
    const kinds = marketFlagKinds(f, borrowUsdOf(feed, market, f))
    if (!kinds.length) continue
    markets.push({
      claim: CLAIM.marketFlag,
      market,
      marketName: marketLabel(e, market),
      collateralSymbol: symbolOf(e, m.collateral),
      loanSymbol: symbolOf(e, m.loan),
      oracle: f.oracle,
      kinds,
      curatedUsd: vs.length ? vs.reduce((s, v) => s + (v.usd ?? 0), 0) : undefined,
      vaults: vs,
      texts: marketFlagTexts(feed, market, f, kinds, fmt),
    })
  }
  markets.sort(
    (a, b) =>
      Number(b.kinds.includes('oracle-reverting')) - Number(a.kinds.includes('oracle-reverting')) ||
      (b.curatedUsd ?? 0) - (a.curatedUsd ?? 0),
  )
  const byId = new Map(feed.actions.map((a) => [a.id, a]))
  const shifts: ShiftView[] = []
  for (const x of flags.shifts) {
    const m = e.markets[x.market]
    if (!m || (q.market && x.market !== q.market) || !coll([m.collateral])) continue
    if (q.curator && ![...x.from, ...x.to].some((v) => cur(v.vault))) continue
    const loan = symbolOf(e, m.loan)
    const side = (vs: { vault: string; amount: number }[]) =>
      vs.map((v) => ({ vault: v.vault, vaultName: vaultLabel(e, v.vault), amount: v.amount }))
    const from = side(x.from)
    const to = side(x.to)
    const cuts = x.cuts.map((c) => ({
      vault: c.vault,
      vaultName: vaultLabel(e, c.vault),
      ts: c.ts,
      kind: byId.get(c.actionId)?.kind ?? 'cap_zero',
    }))
    const curatorName = curatorLabel(e, x.from[0].vault)
    const who = /^0x[0-9a-f]{40}$/i.test(curatorName)
      ? `The curator ${short(curatorName)}`
      : curatorName
    const list = (vs: { vaultName: string; amount: number }[], sign: string) =>
      vs.map((v) => `${v.vaultName} ${sign}${fmt(v.amount)} ${loan}`).join(', ')
    const text =
      `${who} moved${x.usd !== undefined ? ` ≈ $${fmt(x.usd)} of` : ''} ${marketLabel(e, x.market)} between its own vaults on ${x.day} (net, UTC day): ${list(from, '−')}; ${list(to, '+')}. ` +
      `Then ${cuts.map((c) => `${c.vaultName} ${CUT_TEXT[c.kind] ?? c.kind} on ${symbolOf(e, m.collateral)} (${utc(c.ts)})`).join('; ')}.`
    shifts.push({
      claim: CLAIM.shift,
      curatorName,
      market: x.market,
      marketName: marketLabel(e, x.market),
      day: x.day,
      usd: x.usd,
      from,
      to,
      cuts,
      text,
    })
  }
  return { block: flags.block, ts: flags.ts, markets, shifts }
}

// ── oracle gap (lib/curatorFeed/oracleGap.ts) ──────────────────────────────────

export interface OracleGapMarketView {
  claim: typeof CLAIM.oracleGap
  market: string
  marketName: string
  /** Collateral and loan token addresses, lowercase. */
  collateral: string
  loan: string
  collateralSymbol: string
  loanSymbol: string
  oracle: string
  /** The $ exposed: what curated vaults supply to it at the last exposure read, USD. */
  curatedUsd?: number
  /** Supply-locked market (flag 5): curatedUsd is book value, not live supply. */
  locked: boolean
  vaults: { vault: string; vaultName: string; curatorName: string; share: number; usd?: number }[]
  i3: I3Result
  /** The newest observed point's two prices. The oracle in USD: with the loan token at its
   *  peg when it has one (the collateral-side figure), else at DefiLlama's loan price. */
  latest?: {
    ts: number
    oracleUsd: number
    marketUsd: number
    marketConfidence?: number
    /** The whole gap as read (loan token at DefiLlama), kept for audit when split. */
    fullGap?: number
  }
  /** The loan token against its peg at the newest observed point (PEGS): msUSD $0.885 vs
   *  $1 assumed. Undefined for a loan token with no peg. */
  loanSide?: {
    symbol: string
    ref: PegRef
    loanUsd: number
    pegUsd: number
    /** loanUsd ÷ pegUsd − 1 */
    gap: number
  }
  /** The collateral is a pegged token the oracle holds at its peg (within
   *  PEG_ASSUMED_WITHIN) while its market is ≥ the line away: "peg assumed". */
  pegAssumed?: boolean
  /** A Pendle PT: its oracle prices it to maturity, not at market. */
  pt?: boolean
  /** The newest point when it was priced but below MIN_PRICE_CONFIDENCE (not counted). */
  lastRaw?: {
    ts: number
    oracleUsd: number
    marketUsd: number
    marketConfidence?: number
    rawGap: number
  }
  /** The last 2 × persistence points, oldest first; gap null = unobserved. */
  series: { ts: number; gap: number | null }[]
  /** The viewer's tie to the market. Never sent by the API: attached client-side from a
   *  read-only wallet read or a chosen curator (lib/exposure withRelations). */
  relation?: Relation
}

export interface OracleGapResponse {
  meta: {
    now: number
    /** False until the collector has written a first oracle-gap point. */
    measured: boolean
    runs: number
    firstRunTs?: number
    lastRunTs?: number
    lastRunBlock?: number
    keepDays?: number
    staleHours: number
    /** The newest run is older than staleHours. */
    stale: boolean
    marketSource: 'defillama'
    /** The exposure read the vault lists come from. */
    exposureBlock: number
    exposureTs: number
  }
  constants: I3Constants
  record: I3Record
  /** Over every market measured (or held and never observed), before the limit. */
  counts: Record<I3State, number>
  /** Curated supply (USD, last exposure read) in the markets of each state. */
  curatedUsd: Record<I3State, number>
  /** The part of curatedUsd that is book value (supply-locked markets, flag 5). */
  bookUsd: Record<I3State, number>
  /** Markets of each state with at least EXPOSED_MIN_USD of curated supply. */
  exposed: Record<I3State, number>
  /** Below this curated supply a market counts as having no curated exposure. */
  exposedMinUsd: number
  /**
   * Every Morpho vault of the exposure read (MetaMorpho V1 and Vault V2), by lowercase
   * address: what a viewer's read needs (lib/exposure). `usdPerAsset`: totalUsd /
   * totalAssets at the exposure read, USD per base unit of the vault's asset.
   */
  vaults: Record<
    string,
    { protocol: 'morpho-v1' | 'morpho-v2'; name: string; curatorName: string; usdPerAsset?: number }
  >
  markets: OracleGapMarketView[]
  total: number
  /** Curator cuts on each listed market's collateral (lowercase address), from the feed:
   *  the "peer moves" row of a card's signals. */
  peerMoves: Record<string, PeerMoves>
}

// ── peer moves: curator cuts on a collateral ─────────────────────────────────

/** A cut: a cap lowered or zeroed, a market removed or queued for removal, a market
 *  taken out of the supply queue. */
export const PEER_CUT_KINDS: ReadonlySet<ActionKind> = new Set<ActionKind>([
  'cap_cut',
  'cap_zero',
  'removal_submit',
  'market_removed',
  'supply_queue_remove',
])

export interface PeerWindow {
  /** Feed rows (deduped as the feed lists them) in the window. */
  count: number
  /** Distinct curator names, most rows first. */
  curators: string[]
}

export interface PeerMoves {
  h24: PeerWindow
  d7: PeerWindow
  /** The feed's own span: a window outside it was not read. */
  feedFromTs?: number
  feedToTs?: number
}

const DAY = 86400

/**
 * Curator cuts on each collateral in the last 24 h and 7 d before `nowS`, from the feed's
 * actions. Only rows inside [nowS − 7 d, nowS] count; the feed's span goes with it, so a
 * window the feed did not cover reads as not read, never as none.
 */
export function peerMovesOf(
  feed: FeedFile,
  collaterals: ReadonlySet<string>,
  nowS: number,
): Record<string, PeerMoves> {
  const rows = dedupeSameRows(
    feed.actions
      .filter(
        (a) =>
          PEER_CUT_KINDS.has(a.kind) &&
          a.ts <= nowS &&
          a.ts > nowS - 7 * DAY &&
          a.collateral.some((c) => collaterals.has(c.toLowerCase())),
      )
      .sort((x, y) => y.block - x.block || y.id.localeCompare(x.id)),
    (a) => a,
    (a) => statusOf(a, nowS),
  )
  const tally = (xs: FeedAction[]): PeerWindow => {
    const by = new Map<string, number>()
    for (const a of xs) {
      const n = curatorLabel(feed.entities, a.vault)
      by.set(n, (by.get(n) ?? 0) + 1)
    }
    return {
      count: xs.length,
      curators: [...by].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0])).map(([n]) => n),
    }
  }
  const out: Record<string, PeerMoves> = {}
  for (const c of collaterals) {
    const mine = rows.filter((a) => a.collateral.some((x) => x.toLowerCase() === c))
    out[c] = {
      h24: tally(mine.filter((a) => a.ts > nowS - DAY)),
      d7: tally(mine),
      feedFromTs: feed.meta.fromTs,
      feedToTs: feed.meta.toTs,
    }
  }
  return out
}

/**
 * What a card says beside its figure: the loan token against its peg, a collateral the
 * oracle holds at its peg, a PT priced to maturity. From the newest observed point.
 */
export function gapNotes(
  m: { collateral: string; loan: string },
  last: GapObservation | undefined,
  collateralSymbol: string,
  c: Pick<I3Constants, 'gap'>,
): Pick<OracleGapMarketView, 'loanSide' | 'pegAssumed' | 'pt'> {
  const out: Pick<OracleGapMarketView, 'loanSide' | 'pegAssumed' | 'pt'> = {}
  const loanPeg = pegOf(m.loan)
  if (
    loanPeg &&
    last?.loanUsd !== undefined &&
    last.loanPegUsd !== undefined &&
    last.loanGap !== undefined
  )
    out.loanSide = {
      symbol: loanPeg.symbol,
      ref: loanPeg.ref,
      loanUsd: last.loanUsd,
      pegUsd: last.loanPegUsd,
      gap: last.loanGap,
    }
  // Only a USD peg is checked: an ETH-pegged collateral's peg value is not stored per row.
  const collPeg = pegOf(m.collateral)
  const g = last?.gap
  if (
    collPeg?.ref === 'USD' &&
    g !== undefined &&
    g !== null &&
    Math.abs(g) >= c.gap &&
    last?.oracleUsd !== undefined &&
    Math.abs(last.oracleUsd - 1) <= PEG_ASSUMED_WITHIN
  )
    out.pegAssumed = true
  if (/^PT-/.test(collateralSymbol)) out.pt = true
  return out
}

/** A curated allocation under $1 rounds to nothing: no curated exposure. */
export const EXPOSED_MIN_USD = 1

/** Fired, then above the line for under 24 h, then the rest. Stale: as of its last point. */
function rankOf(r: I3Result): number {
  const above = r.hoursAboveConsecutive
  switch (r.state) {
    case 'fired':
      return 0
    case 'building':
      return 1
    case 'stale':
      return above >= r.persistence ? 0 : above > 0 ? 1 : 2
    case 'below':
      return 2
    default:
      return 3
  }
}

/**
 * Every market the gap series holds, plus held markets it never observed (no DefiLlama
 * price, or a reverting oracle since the first run), evaluated at `nowS`. Sorted fired
 * first, then above the line for under 24 h, then the rest; inside each, by the $ exposed
 * (curated supply), then by consecutive hours above the line.
 */
export function buildOracleGapResponse(
  feed: FeedFile,
  exposure: ExposureFile,
  gap: OracleGapFile | null,
  record: I3Record,
  q: FeedQuery,
  nowS: number,
): OracleGapResponse {
  const e = feed.entities
  const constants: I3Constants = {
    gap: record.constants.gap,
    persistenceHours: record.constants.persistenceHours,
    persistenceDailyPoints: record.constants.persistenceDailyPoints,
  }
  const decoded = gap ? decodeGapFile(gap) : null
  const lastRun = decoded?.runs.at(-1)
  const zero = (): Record<I3State, number> => ({
    fired: 0,
    building: 0,
    below: 0,
    stale: 0,
    unobserved: 0,
  })
  const counts = zero()
  const curatedUsd = zero()
  const exposed = zero()
  const bookUsd = zero()
  const vaults: OracleGapResponse['vaults'] = {}
  for (const v of exposure.vaults) {
    if (v.protocol !== 'morpho-v1' && v.protocol !== 'morpho-v2') continue
    const total = BigInt(v.totalAssets)
    vaults[v.vault.toLowerCase()] = {
      protocol: v.protocol,
      name: vaultLabel(e, v.vault),
      curatorName: curatorLabel(e, v.vault),
      ...(v.totalUsd !== undefined && total > 0n
        ? { usdPerAsset: v.totalUsd / Number(total) }
        : {}),
    }
  }
  const empty = { counts, curatedUsd, bookUsd, exposed, exposedMinUsd: EXPOSED_MIN_USD, vaults }
  const meta: OracleGapResponse['meta'] = {
    now: nowS,
    measured: Boolean(lastRun),
    runs: decoded?.runs.length ?? 0,
    firstRunTs: decoded?.runs[0]?.ts,
    lastRunTs: lastRun?.ts,
    lastRunBlock: lastRun?.block,
    keepDays: gap?.keepDays,
    staleHours: STALE_HOURS,
    stale: lastRun ? nowS - lastRun.ts > STALE_HOURS * 3600 : false,
    marketSource: 'defillama',
    exposureBlock: exposure.block,
    exposureTs: exposure.ts,
  }
  if (!decoded || !lastRun)
    return { meta, constants, record, ...empty, markets: [], total: 0, peerMoves: {} }

  const holders = new Map<string, OracleGapMarketView['vaults']>()
  for (const v of exposure.vaults)
    for (const a of v.allocations) {
      if (!e.markets[a.target]) continue
      holders.set(a.target, [
        ...(holders.get(a.target) ?? []),
        {
          vault: v.vault,
          vaultName: vaultLabel(e, v.vault),
          curatorName: curatorLabel(e, v.vault),
          share: a.share,
          usd: a.usd,
        },
      ])
    }
  const ZERO = '0x0000000000000000000000000000000000000000'
  const ids = new Set<string>(decoded.byMarket.keys())
  for (const t of holders.keys()) {
    const m = e.markets[t]
    if (m.collateral !== ZERO && m.oracle.toLowerCase() !== ZERO) ids.add(t)
  }
  const coll = collateralMatcher(feed, q.collateral)
  const cur = curatorMatcher(feed, q.curator)
  const need = 2 * constants.persistenceHours
  const all: OracleGapMarketView[] = []
  for (const market of ids) {
    const m = e.markets[market]
    if (!m || (q.market && market !== q.market) || !coll([m.collateral])) continue
    const vs = (holders.get(market) ?? []).sort((a, b) => (b.usd ?? 0) - (a.usd ?? 0))
    if (q.curator && !vs.some((v) => cur(v.vault))) continue
    const obs: GapObservation[] = decoded.byMarket.get(market) ?? []
    const i3 = evaluateI3(obs, constants, nowS)
    const lastObs = [...obs].reverse().find((o) => o.gap !== null)
    const newest = obs[obs.length - 1]
    all.push({
      claim: CLAIM.oracleGap,
      market,
      marketName: marketLabel(e, market),
      collateral: m.collateral.toLowerCase(),
      loan: m.loan.toLowerCase(),
      collateralSymbol: symbolOf(e, m.collateral),
      loanSymbol: symbolOf(e, m.loan),
      oracle: m.oracle.toLowerCase(),
      curatedUsd: vs.length ? vs.reduce((s, v) => s + (v.usd ?? 0), 0) : undefined,
      locked: isLockedMarket(feed, market),
      vaults: vs,
      i3,
      latest:
        lastObs && lastObs.oracleUsd !== undefined && lastObs.marketUsd !== undefined
          ? {
              ts: lastObs.ts,
              oracleUsd: lastObs.oracleUsd,
              marketUsd: lastObs.marketUsd,
              marketConfidence: lastObs.marketConfidence,
              ...(lastObs.fullGap !== undefined ? { fullGap: lastObs.fullGap } : {}),
            }
          : undefined,
      ...gapNotes(m, lastObs, symbolOf(e, m.collateral), constants),
      lastRaw:
        newest?.rawGap !== undefined &&
        newest.oracleUsd !== undefined &&
        newest.marketUsd !== undefined
          ? {
              ts: newest.ts,
              oracleUsd: newest.oracleUsd,
              marketUsd: newest.marketUsd,
              marketConfidence: newest.marketConfidence,
              rawGap: newest.rawGap,
            }
          : undefined,
      series: obs.slice(-need).map((o) => ({ ts: o.ts, gap: o.gap })),
    })
  }
  for (const x of all) {
    counts[x.i3.state]++
    curatedUsd[x.i3.state] += x.curatedUsd ?? 0
    if (x.locked) bookUsd[x.i3.state] += x.curatedUsd ?? 0
    if ((x.curatedUsd ?? 0) >= EXPOSED_MIN_USD) exposed[x.i3.state]++
  }
  all.sort(
    (a, b) =>
      rankOf(a.i3) - rankOf(b.i3) ||
      (b.curatedUsd ?? 0) - (a.curatedUsd ?? 0) ||
      b.i3.hoursAboveConsecutive - a.i3.hoursAboveConsecutive ||
      (a.market < b.market ? -1 : 1),
  )
  const markets = all.slice(0, q.limit)
  return {
    meta,
    constants,
    record,
    ...empty,
    markets,
    total: all.length,
    peerMoves: peerMovesOf(feed, new Set(markets.map((x) => x.collateral)), nowS),
  }
}

export { FLAG_DEFAULTS }
