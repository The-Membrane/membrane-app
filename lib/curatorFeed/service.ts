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
 */

import { attribute, type Attribution } from './attribution'
import { clusteredIds, detectExitClusters, isDirectExit, type ClusterOptions } from './clusters'
import { byCollateral, type CollateralRow } from './exposure'
import { actionText, curatorLabel, marketLabel, symbolOf, targetLabel, vaultLabel } from './format'
import type { ExposureAlloc } from './types'
import { secondsLeft, statusOf, toneOf, type Tone } from './status'
import type { ExposureFile, FeedFile, FeedMeta } from './store'
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
  view: 'feed' | 'exposure' | 'attribution'
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
  only?: 'spike' | 'drained'
  /** exposure view: pivot by collateral (default) or list by vault. */
  by: 'collateral' | 'vault'
}

const one = (v: string | string[] | undefined): string | undefined => (Array.isArray(v) ? v[0] : v)

export function parseFeedQuery(q: Record<string, string | string[] | undefined>): FeedQuery {
  const view = one(q.view) ?? 'feed'
  if (!['feed', 'exposure', 'attribution'].includes(view))
    throw new QueryError('view must be feed, exposure or attribution')
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
  if (only && only !== 'spike' && only !== 'drained')
    throw new QueryError('only must be spike or drained')
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
} as const satisfies Record<string, ClaimClass>

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
  const all = feed.actions
    .filter(pass)
    .map((a) => ({ a, status: statusOf(a, nowS) }))
    .sort((x, y) => y.a.block - x.a.block || y.a.id.localeCompare(x.a.id))
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
  shareOfVault: number
}
export interface ExposureRowView {
  collateral: string
  symbol: string
  usd: number
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
  )
  return {
    block: exposure.block,
    ts: exposure.ts,
    rows: rows
      .filter((r) => coll([r.collateral]) && r.usd >= q.minUsd)
      .map((r) => ({
        collateral: r.collateral,
        symbol: symbolOf(feed.entities, r.collateral),
        usd: r.usd,
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
}
export interface VaultExposureView {
  vault: string
  vaultName: string
  curatorName: string
  protocol: Protocol
  loanSymbol: string
  totalUsd?: number
  allocations: VaultAllocView[]
}

/** vault → markets / strategies → collateral → share of the vault. Largest vaults first. */
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
      return {
        vault: v.vault,
        vaultName: vaultLabel(feed.entities, v.vault),
        curatorName: curatorLabel(feed.entities, v.vault),
        protocol: v.protocol,
        loanSymbol: symbolOf(feed.entities, asset),
        totalUsd: v.totalUsd,
        allocations: v.allocations.map((a) => ({
          target: a.target,
          targetName: label(a),
          collateralSymbols: a.collateral.map((c) => symbolOf(feed.entities, c)),
          amount: Number(BigInt(a.assets)) / 10 ** dec,
          usd: a.usd,
          share: a.share,
          via: a.via,
        })),
      }
    })
    .sort((a, b) => (b.totalUsd ?? 0) - (a.totalUsd ?? 0))
  return { block: exposure.block, ts: exposure.ts, vaults }
}
