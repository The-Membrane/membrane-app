// Server-side builder for the CONFIG CARDS view (docs/research/CONFIG-CARDS-DESIGN.md §6):
// turns the collector's head state, change history and queues for one subject into the
// compact payload in ./apiTypes.ts. Pure: no fs, no network, no clock — the loader
// (./server.ts) reads the files and the caller passes everything in.
//
// Colour rules live in the client view-model (components/OracleRegistry/configViewModel.ts);
// this module only carries facts: state, stage, red, rule IDs, tags, links.
//
// Two joins the engine output does not carry directly:
//   * remote route reads are keyed by the REMOTE peer address, so they are joined to the local
//     OApp through the latest peer each (oapp, eid) was set to in the change history;
//   * "executable by" for a pending timelock op is replayed from that timelock's EXECUTOR_ROLE
//     grant / revoke changes (address 0 ⇒ anyone). With no such events it stays null and the
//     card says the executor was not read — never a guess.

import { getAddress } from 'viem'

import type {
  BreachView,
  ConfigCardView,
  ConfigChangeView,
  ConfigCounts,
  ConfigTabSummary,
  DelayChip,
  DvnView,
  GovChannelView,
  HolderView,
  ItemView,
  OAppView,
  PowerView,
  QueueView,
  RouteRowView,
  RouteSideView,
} from './apiTypes'
import { floorBreachRoutes } from './bridgeRules'
import { describeController, formatDelay, RULES, treeReadGaps } from './rules'
import { compareValueAtRisk, valueAtRiskLabel } from './value'
import type {
  ConfigChange,
  ConfigSubject,
  Controller,
  Direction,
  GovChannel,
  PowerState,
  StateItem,
  SubjectState,
} from './types'

export type ChangesFile = {
  version: 1
  subject: string
  asOf?: { block: number; ts: number }
  changes: ConfigChange[]
}

export type ConfigInputs = {
  subject: ConfigSubject
  state: SubjectState | null
  /** changes/<subject>.json (historical). */
  changes: ConfigChange[]
  /** queues/<subject>.json (pending + proposed). */
  queue: ConfigChange[]
  /** LayerZero eid → chain name ("Arbitrum"); falls back to the engine's chain key. */
  eidNames?: Record<string, string>
  /** Oracle-catalog entries for the subject's asset (0 when config-only). */
  oracleEntries?: number
  /**
   * Fail-closed audit (ST-06): the change / queue file could not be read or does not match the
   * head state — read gaps, and the reds the state counted that the rows read cannot show
   * (`carriedRed`: still counted, in effect).
   */
  fileGaps?: string[]
  carriedRed?: number
}

/** Quiet historical rows kept by default (every red or still-in-effect row is always kept). */
export const HISTORICAL_KEEP = 40

const ZERO = '0x0000000000000000000000000000000000000000'
const lc = (a: string | null | undefined): string => String(a ?? '').toLowerCase()
const isAddr = (a: unknown): a is string => typeof a === 'string' && /^0x[0-9a-fA-F]{40}$/.test(a)

// ---- links ------------------------------------------------------------------------------------

/** Block explorers by EVM chain id (Etherscan family where one exists). Unknown ⇒ no link. */
export const EXPLORERS: Record<number, string> = {
  1: 'https://etherscan.io',
  10: 'https://optimistic.etherscan.io',
  56: 'https://bscscan.com',
  130: 'https://uniscan.xyz',
  146: 'https://sonicscan.org',
  252: 'https://fraxscan.com',
  324: 'https://era.zksync.network',
  1923: 'https://explorer.swellnetwork.io',
  5000: 'https://mantlescan.xyz',
  8453: 'https://basescan.org',
  34443: 'https://explorer.mode.network',
  42161: 'https://arbiscan.io',
  43114: 'https://snowtrace.io',
  57073: 'https://explorer.inkonchain.com',
  59144: 'https://lineascan.build',
  60808: 'https://explorer.gobob.xyz',
  80094: 'https://berascan.com',
  81457: 'https://blastscan.io',
  534352: 'https://scrollscan.com',
}

export function explorerTxUrl(chainId: number, tx: string | null | undefined): string | null {
  const base = EXPLORERS[chainId]
  return base && tx && /^0x[0-9a-fA-F]{64}$/.test(tx) ? `${base}/tx/${tx}` : null
}

export function explorerAddressUrl(
  chainId: number,
  address: string | null | undefined,
): string | null {
  const base = EXPLORERS[chainId]
  return base && isAddr(address) && lc(address) !== ZERO ? `${base}/address/${address}` : null
}

/** Safe{Wallet} page of one queued transaction (Ethereum). */
export function safeTxUrl(safe: string, safeTxHash: string): string | null {
  if (!isAddr(safe) || !/^0x[0-9a-fA-F]{64}$/.test(safeTxHash)) return null
  const s = getAddress(safe)
  return `https://app.safe.global/transactions/tx?safe=eth:${s}&id=multisig_${s}_${safeTxHash}`
}

export function govChannelView(g: GovChannel): GovChannelView {
  return g.kind === 'snapshot'
    ? { kind: 'snapshot', label: `Snapshot ${g.space}`, url: `https://snapshot.org/#/${g.space}` }
    : { kind: 'discourse', label: g.base.replace(/^https?:\/\//, ''), url: g.base }
}

// ---- small formatting -------------------------------------------------------------------------

const short = (a: string): string => (isAddr(a) ? `${a.slice(0, 6)}…${a.slice(-4)}` : a)

/** "rsETH (Kelp)" → "rsETH"; "PT-srUSDe (Pendle × Strata)" → "PT-srUSDe". */
export const subjectSymbol = (label: string): string => label.split(' (')[0].trim() || label

/** The asset tab a subject's config belongs to. */
export const subjectSlug = (s: Pick<ConfigSubject, 'key' | 'oracleAssetKey'>): string =>
  (s.oracleAssetKey || s.key).toLowerCase()

/**
 * The catalog slug to open for a requested ?asset=: a config subject's own key
 * (`pt-srusde`) resolves to its oracle asset (`pt-srusde-22oct2026`), never to the default
 * asset. Anything else is passed through.
 */
export const requestedAssetSlug = (
  requested: string,
  subject: Pick<ConfigSubject, 'key' | 'oracleAssetKey'> | null,
): string => (subject?.oracleAssetKey ? subjectSlug(subject) : requested)

export function holderView(c: Controller | null | undefined): HolderView {
  if (!c) return { kind: 'unresolved', label: 'unresolved', url: null }
  return { kind: c.kind, label: describeController(c), url: explorerAddressUrl(1, c.address) }
}

export function delayLabel(sec: number): string {
  return sec < 0 ? 'immutable' : formatDelay(sec)
}

/** A value that renders on one line: a display string, an address, a number. */
function scalar(v: unknown): string | null {
  if (v == null) return null
  if (typeof v === 'string') {
    // Plain regex, not the isAddr type guard: a guard on a `string` narrows the rest to never.
    if (/^0x[0-9a-fA-F]{40}$/.test(v)) return short(v)
    // bytes32 (LayerZero peers): a left-padded address reads as the address; all zero as 0x0.
    if (/^0x[0-9a-fA-F]{64}$/.test(v)) {
      if (/^0x0{64}$/.test(v)) return '0x0 (none)'
      if (/^0x0{24}/.test(v)) return short(`0x${v.slice(26)}`)
      return `${v.slice(0, 10)}…${v.slice(-4)}`
    }
    return v
  }
  if (typeof v === 'number' || typeof v === 'boolean') return String(v)
  return null
}

/** "Safe 0x3b0aaf6e… nonce 740: 2/5 signatures" (or a MultiSigWallet's "2/6 confirmations") → "2/5". */
export function signaturesOf(notes: readonly string[] | undefined): string | null {
  for (const n of notes ?? []) {
    const m = n.match(/(\d+)\/(\d+) (?:signatures|confirmations)/)
    if (m) return `${m[1]}/${m[2]}`
  }
  return null
}

// ---- executors (who can call execute() on a timelock) -----------------------------------------

/**
 * Current EXECUTOR_ROLE holders per timelock, replayed oldest → newest from the role changes
 * the collector recorded (grant ⇒ `after` holds the role, revoke ⇒ `before` lost it).
 * Value: holder address → description taken from the change title.
 */
export function executorsByTimelock(
  changes: readonly ConfigChange[],
): Map<string, Map<string, string>> {
  const out = new Map<string, Map<string, string>>()
  const rows = changes
    .filter((c) => /^admin\/role\/0x[0-9a-f]{40}\/EXECUTOR_ROLE$/.test(c.key))
    .slice()
    .sort((a, b) => (a.block ?? 0) - (b.block ?? 0) || a.id.localeCompare(b.id))
  for (const c of rows) {
    const timelock = c.key.split('/')[2]
    const set = out.get(timelock) ?? new Map<string, string>()
    out.set(timelock, set)
    const granted = c.title.match(/granted to (.+) on 0x/)
    if (granted && isAddr(c.after)) set.set(lc(c.after), granted[1])
    else if (/revoked/.test(c.title) && isAddr(c.before)) set.delete(lc(c.before))
  }
  return out
}

/** "anyone (open execution)" · "Safe 3-of-6 0xcdd5…8c21" · null when nothing was read. */
export function executableBy(
  timelock: string,
  executors: Map<string, Map<string, string>>,
): string | null {
  const set = executors.get(lc(timelock))
  if (!set || set.size === 0) return null
  if (set.has(ZERO)) return 'anyone (open execution)'
  return [...set.values()].join(' or ')
}

// ---- timeline -------------------------------------------------------------------------------

const STAGE_ORDER: Record<string, number> = { armed: 0, scheduled: 1, stale: 2 }

/** Pending (armed → scheduled by ETA → stale), then proposed (newest), then historical (newest). */
export function orderTimeline<
  T extends Pick<ConfigChangeView, 'state' | 'stage' | 'eta' | 'ts' | 'block' | 'id'>,
>(rows: readonly T[]): T[] {
  const rank = (r: T) => (r.state === 'pending' ? 0 : r.state === 'proposed' ? 1 : 2)
  return rows.slice().sort((a, b) => {
    const s = rank(a) - rank(b)
    if (s) return s
    if (a.state === 'pending') {
      const st = (STAGE_ORDER[a.stage ?? ''] ?? 1) - (STAGE_ORDER[b.stage ?? ''] ?? 1)
      if (st) return st
      const e = (a.eta ?? Infinity) - (b.eta ?? Infinity)
      if (e) return e
    } else if (a.state === 'proposed') {
      const t = (b.ts ?? 0) - (a.ts ?? 0)
      if (t) return t
    } else {
      const bl = (b.block ?? 0) - (a.block ?? 0)
      if (bl) return bl
    }
    return a.id.localeCompare(b.id)
  })
}

/**
 * Keeps every pending, proposed, red and still-in-effect row, plus the newest `keep` quiet
 * historical rows. Input must already be ordered.
 */
export function trimTimeline<T extends Pick<ConfigChangeView, 'state' | 'red' | 'stillInEffect'>>(
  ordered: readonly T[],
  keep: number,
): { rows: T[]; historicalTotal: number; historicalShown: number } {
  let quiet = 0
  let historicalTotal = 0
  let historicalShown = 0
  const rows: T[] = []
  for (const r of ordered) {
    if (r.state !== 'historical') {
      rows.push(r)
      continue
    }
    historicalTotal++
    if (r.red || r.stillInEffect || quiet < keep) {
      if (!r.red && !r.stillInEffect) quiet++
      rows.push(r)
      historicalShown++
    }
  }
  return { rows, historicalTotal, historicalShown }
}

export function toChangeView(
  c: ConfigChange,
  ctx: { executors: Map<string, Map<string, string>>; eidName: (eid: number) => string },
): ConfigChangeView {
  let queue: QueueView | null = null
  if (c.queue) {
    queue =
      c.queue.kind === 'safe'
        ? {
            kind: 'safe',
            address: c.queue.address,
            opId: c.queue.opId,
            label: `Safe ${short(c.queue.address)}`,
            url: safeTxUrl(c.queue.address, c.queue.opId),
          }
        : c.queue.kind === 'dg_timelock'
          ? {
              kind: 'dg_timelock',
              address: c.queue.address,
              opId: c.queue.opId,
              label: `Dual Governance proposal #${c.queue.opId}`,
              url: explorerAddressUrl(c.chainId || 1, c.queue.address),
            }
          : c.queue.kind === 'legacy_multisig'
            ? {
                kind: 'legacy_multisig',
                address: c.queue.address,
                opId: c.queue.opId,
                label: `MultiSigWallet ${short(c.queue.address)} tx ${c.queue.opId}`,
                url: explorerAddressUrl(c.chainId || 1, c.queue.address),
              }
            : {
                kind: 'oz_timelock',
                address: c.queue.address,
                opId: c.queue.opId,
                label: `Timelock ${short(c.queue.address)}`,
                url: explorerAddressUrl(c.chainId || 1, c.queue.address),
              }
  }
  const before = c.beforeDisplay ?? scalar(c.before)
  const after0 = c.afterDisplay ?? scalar(c.after)
  // two equal lines never read as a change (review round 7): a value set again says so
  const after =
    before !== null && after0 !== null && before === after0 ? `${after0} (same as before)` : after0
  return {
    id: c.id,
    state: c.state,
    stage: c.stage ?? null,
    dimension: c.dimension,
    title: c.title,
    before,
    after,
    red: !!c.red,
    severity: c.severity,
    floorBreach: !!c.floorBreach,
    ruleIds: c.ruleIds ?? [],
    tags: c.tags ?? [],
    stillInEffect: !!c.stillInEffect,
    announcement: c.announcement,
    unannounced: c.unannounced ?? null,
    chainId: c.chainId || 1,
    block: c.block ?? null,
    blockFrom: c.blockFrom ?? null,
    ts: c.ts ?? null,
    eta: c.eta ?? null,
    txUrl: explorerTxUrl(c.chainId || 1, c.tx),
    queue,
    executableBy:
      c.state === 'pending' && c.queue?.kind === 'oz_timelock'
        ? executableBy(c.queue.address, ctx.executors)
        : null,
    signatures:
      c.queue?.kind === 'safe' || c.queue?.kind === 'legacy_multisig'
        ? signaturesOf(c.notes)
        : null,
    route: c.route
      ? {
          eid: c.route.eid,
          // a queued setPeer moves both directions (review round 7: it read "receive")
          direction: c.key.endsWith('/peer') ? ('both' as const) : c.route.direction,
          chain: ctx.eidName(c.route.eid),
        }
      : null,
    notes: c.notes ?? [],
  }
}

// ---- counts ---------------------------------------------------------------------------------

/**
 * Every state rule failing now. Floor breaches (BR-2) lead, sorted by the value at risk behind
 * the route — the severity rank, worst first (owner ruling 2026-10-06 #9); a value that was not
 * read sorts FIRST, labelled "value unread" (owner ruling 2026-10-08 #14, fail closed). Other
 * breaches keep the engine's order after them.
 */
export function breachesOf(items: readonly StateItem[]): ConfigCardView['breaches'] {
  const out: ConfigCardView['breaches'] = []
  for (const i of items) {
    // a route item names its side ("eid 30110 (arbitrum) receive" / "… remote send"): three
    // floor breaches no longer read as three identical lines (review round 5)
    const where = /^eid \d+ \([^)]*\)[^:]*:/.test(i.display)
      ? i.display.slice(0, i.display.indexOf(':'))
      : undefined
    for (const b of i.breaches ?? [])
      out.push({
        ruleId: b.ruleId,
        message: b.message,
        ...(where ? { where } : {}),
        // UQ-30: carried, not re-confirmed — still counted and red
        ...(b.unconfirmed ? { unconfirmed: b.unconfirmed.readGap } : {}),
        dimension: i.dimension,
        key: i.key,
        ...(b.ruleId === 'BR-2'
          ? {
              valueAtRiskUsd: i.valueAtRisk?.usd ?? null,
              valueAtRisk: valueAtRiskLabel(i.valueAtRisk),
              // review round 9: a partial read sorts with the unread ones (ruling #14)
              ...(i.valueAtRisk?.unread.length
                ? { valueAtRiskUnread: [...i.valueAtRisk.unread] }
                : {}),
            }
          : {}),
      })
  }
  const floor = out
    .map((b, n) => ({ b, n }))
    .filter((x) => x.b.ruleId === 'BR-2')
    .sort(
      (x, y) =>
        compareValueAtRisk(
          { usd: x.b.valueAtRiskUsd ?? null, unread: x.b.valueAtRiskUnread },
          { usd: y.b.valueAtRiskUsd ?? null, unread: y.b.valueAtRiskUnread },
        ) || x.n - y.n,
    )
    .map((x) => x.b)
  return [...floor, ...out.filter((b) => b.ruleId !== 'BR-2')]
}

export function countsOf(
  items: readonly StateItem[],
  changes: readonly Pick<ConfigChange, 'state' | 'stage' | 'red' | 'stillInEffect'>[],
  readGaps: readonly string[] = [],
): ConfigCounts {
  const breaches = breachesOf(items)
  // routes, not sides (review round 7): the same count as the bridge block's "under floor"
  const floorBreaches = floorBreachRoutes(items).length
  const ruleBreaches = breaches.filter((b) => b.ruleId !== 'BR-2').length
  let redInEffect = 0
  let redOpen = 0
  let redTotal = 0
  let pending = 0
  let armed = 0
  let stale = 0
  let proposed = 0
  let armedProposed = 0
  let historical = 0
  for (const c of changes) {
    if (c.red) redTotal++
    if (c.state === 'pending') {
      if (c.stage === 'stale') {
        stale++
        // a red op past its ETA is still queued: it counts as an open red flag
        if (c.red) redOpen++
      } else {
        pending++
        if (c.stage === 'armed') armed++
        if (c.red) redOpen++
      }
    } else if (c.state === 'proposed') {
      proposed++
      // a fully signed Safe transaction: anyone can execute it now (review round 6)
      if (c.stage === 'armed') armedProposed++
      if (c.red) redOpen++
    } else {
      historical++
      if (c.red && c.stillInEffect) redInEffect++
    }
  }
  const unread = items.filter((i) =>
    (i.warnings ?? []).some((w) => w === 'UNREAD' || w === 'REMOTE UNREAD'),
  ).length
  return {
    unread,
    readGaps: readGaps.length,
    floorBreaches,
    ruleBreaches,
    redInEffect,
    redOpen,
    openRed: floorBreaches + ruleBreaches + redInEffect + redOpen,
    redTotal,
    pending,
    armed,
    stale,
    proposed,
    armedProposed,
    historical,
  }
}

// ---- bridge -------------------------------------------------------------------------------------

const LOCAL_ROUTE = /^bridge\/lz\/1\/(0x[0-9a-f]{40})\/(\d+)\/(send|receive)$/
const REMOTE_ROUTE = /^bridge\/lz\/(\d+)\/(0x[0-9a-f]{40})\/30101\/(send|receive)$/
const REMOTE_UNREAD = /^bridge\/lz\/remote\/(\d+)\/(0x[0-9a-f]{40})$/

/** "eid 30110 (arbitrum) remote receive: …" → { eid: 30110, chainKey: 'arbitrum' }. */
export function eidPrefix(display: string): { eid: number; chainKey: string } | null {
  const m = display.match(/^eid (\d+) \(([^)]+)\)/)
  return m ? { eid: Number(m[1]), chainKey: m[2] } : null
}

/** The engine's route display after the "eid … :" prefix → shape + confirmations. */
export function routeShape(display: string): { shape: string; confirmations: string | null } {
  const body = display.replace(/^eid \d+ \([^)]+\) [^:]*: /, '')
  if (!body.startsWith('E=')) {
    if (/^BlockedMessageLib/.test(body)) return { shape: 'closed', confirmations: null }
    if (/^blocked/.test(body)) return { shape: 'blocked', confirmations: null }
    return { shape: body.split(' · ')[0] || '—', confirmations: null }
  }
  const parts = body.split(' · ')
  const shape = (parts[1] ?? '')
    .replace(/ \(.*$/, '')
    .replace(' required + ', ' req + ')
    .replace(/ optional$/, ' opt')
  const conf = body.match(/ · (\S+) conf/)
  return { shape: shape || '—', confirmations: conf ? conf[1] : null }
}

type RouteValue = {
  E?: number
  live?: boolean
  operators?: string[]
  issuerRun?: string[]
  confirmations?: string
}

export function routeSide(item: StateItem, direction: Direction): RouteSideView {
  const v = (item.value ?? {}) as RouteValue
  const { shape, confirmations } = routeShape(item.display)
  const breaches = (item.breaches ?? []).map((b) => ({ ruleId: b.ruleId, message: b.message }))
  const unread = (item.warnings ?? []).some((w) => /^(REMOTE )?UNREAD$/.test(w))
    ? item.display
        .split(/UNREAD/)[1]
        ?.replace(/^ — /, '')
        .trim() || 'not read'
    : null
  return {
    unread,
    chainId: item.chainId,
    direction,
    E: typeof v.E === 'number' ? v.E : null,
    live: !!v.live,
    shape,
    operators: Array.isArray(v.operators) ? v.operators : [],
    issuerRun: Array.isArray(v.issuerRun) ? v.issuerRun : [],
    confirmations: v.confirmations ?? confirmations,
    floorBreach: breaches.some((b) => b.ruleId === 'BR-2'),
    breaches,
    tags: item.tags ?? [],
    warnings: item.warnings ?? [],
    display: item.display,
    valueAtRisk: item.valueAtRisk ?? null,
  }
}

/** Latest peer (last 40 hex chars) each (oapp, eid) was set to, from the change history. */
export function latestPeers(changes: readonly ConfigChange[]): Map<string, string> {
  const out = new Map<string, string>()
  const rows = changes
    .filter((c) => c.route && c.state === 'historical')
    .slice()
    .sort((a, b) => (a.block ?? 0) - (b.block ?? 0))
  for (const c of rows) {
    const peer = (c.after as { peer?: unknown } | undefined)?.peer
    if (typeof peer === 'string' && /^0x[0-9a-f]+$/i.test(peer))
      out.set(`${lc(c.route!.oapp)}|${c.route!.eid}`, lc(peer).slice(-40))
  }
  return out
}

export function buildBridge(
  items: readonly StateItem[],
  powers: readonly PowerState[],
  changes: readonly ConfigChange[],
  oappOrder: readonly string[],
  eidName: (eid: number, fallback?: string) => string,
  labels: Record<string, string> = {},
): { oapps: OAppView[]; dvns: DvnView[]; ccip: ItemView[]; warnings: string[] } {
  const warnings: string[] = []
  const rows = new Map<string, RouteRowView>() // `${oapp}|${eid}`
  const oappOf = new Map<string, string>() // row key → oapp
  const row = (oapp: string, eid: number, chainKey: string): RouteRowView => {
    const k = `${oapp}|${eid}`
    let r = rows.get(k)
    if (!r) {
      r = {
        eid,
        chain: eidName(eid, chainKey),
        local: { send: null, receive: null },
        remote: null,
        live: false,
        minE: null,
        floorBreach: false,
        valueAtRisk: null,
      }
      rows.set(k, r)
      oappOf.set(k, oapp)
    }
    return r
  }
  for (const i of items) {
    const m = i.key.match(LOCAL_ROUTE)
    if (!m) continue
    const pre = eidPrefix(i.display)
    row(m[1], Number(m[2]), pre?.chainKey ?? String(m[2])).local[m[3] as Direction] = routeSide(
      i,
      m[3] as Direction,
    )
  }
  const eidOapps = new Map<number, string[]>()
  for (const k of rows.keys()) {
    const [o, e] = k.split('|')
    eidOapps.set(Number(e), [...(eidOapps.get(Number(e)) ?? []), o])
  }
  const peers = latestPeers(changes)
  for (const i of items) {
    const u = i.key.match(REMOTE_UNREAD)
    if (u) {
      // a remote side whose Ethereum route is not at head (zeroed peer) still gets its row: the
      // unread count names it (review round 6)
      const pre = eidPrefix(i.display)
      const r =
        rows.get(`${u[2]}|${Number(u[1])}`) ?? row(u[2], Number(u[1]), pre?.chainKey ?? u[1])
      const reason = i.display.split('REMOTE UNREAD')[1]?.replace(/^ — /, '').trim() || 'not read'
      r.remote = {
        chainId: i.chainId || null,
        address: null,
        url: null,
        send: null,
        receive: null,
        unread: reason,
      }
      continue
    }
    const m = i.key.match(REMOTE_ROUTE)
    if (!m || Number(m[1]) === 1) continue
    const pre = eidPrefix(i.display)
    if (!pre) continue
    const remoteAddr = m[2]
    const candidates = eidOapps.get(pre.eid) ?? []
    const byPeer = candidates.filter((o) => peers.get(`${o}|${pre.eid}`) === remoteAddr.slice(-40))
    // the engine names the Ethereum OApp of a remote side (review round 6: one whose Ethereum
    // peer is zeroed has no local row to match a peer against)
    const named = (i.value as { localOApp?: unknown } | undefined)?.localOApp
    const oapp =
      typeof named === 'string' && /^0x[0-9a-f]{40}$/.test(named)
        ? named
        : byPeer.length === 1
          ? byPeer[0]
          : candidates.length === 1
            ? candidates[0]
            : null
    if (!oapp) {
      warnings.push(
        `remote read eid ${pre.eid} at ${short(remoteAddr)} not matched to a local OApp`,
      )
      continue
    }
    const r = row(oapp, pre.eid, pre.chainKey)
    r.remote ??= {
      chainId: i.chainId,
      address: remoteAddr,
      url: explorerAddressUrl(i.chainId, remoteAddr),
      send: null,
      receive: null,
      unread: null,
    }
    r.remote[m[3] as Direction] = routeSide(i, m[3] as Direction)
  }
  for (const r of rows.values()) {
    const sides = [r.local.send, r.local.receive, r.remote?.send, r.remote?.receive].filter(
      (s): s is RouteSideView => !!s,
    )
    const live = sides.filter((s) => s.live)
    // an unread side keeps the row open: it is unknown, never folded away as closed
    r.live = live.length > 0 || sides.some((s) => !!s.unread)
    const es = live.map((s) => s.E).filter((e): e is number => e != null)
    r.minE = es.length ? Math.min(...es) : null
    r.floorBreach = sides.some((s) => s.floorBreach)
    // the route's value at risk (the same on every side: locked on Ethereum vs remote supply)
    r.valueAtRisk = sides.find((s) => s.valueAtRisk)?.valueAtRisk ?? null
  }

  // "OFTAdapter owner (peers, delegate)" is the OWNER power; the delegate power never says owner.
  const holdersFor = (oapp: string, kind: 'owner' | 'delegate'): HolderView[] => {
    const seen = new Set<string>()
    return powers
      .filter(
        (p) =>
          p.power === 'bridge_config' &&
          lc(p.contract) === oapp &&
          (kind === 'owner'
            ? /owner/i.test(p.label)
            : /delegate/i.test(p.label) && !/owner/i.test(p.label)),
      )
      .flatMap((p) => p.holders)
      .filter((h) => !seen.has(lc(h.address)) && !!seen.add(lc(h.address)))
      .map(holderView)
  }
  const order = [...oappOrder.map(lc), ...[...new Set(oappOf.values())]]
  const oapps: OAppView[] = []
  for (const oapp of [...new Set(order)]) {
    const routes = [...rows.entries()]
      .filter(([k]) => oappOf.get(k) === oapp)
      .map(([, r]) => r)
      .sort(
        (a, b) =>
          Number(b.floorBreach) - Number(a.floorBreach) ||
          // floor breaches: the severity rank — the most value at risk first (ruling #9)
          (a.floorBreach && b.floorBreach ? compareValueAtRisk(a.valueAtRisk, b.valueAtRisk) : 0) ||
          Number(b.live) - Number(a.live) ||
          (a.minE ?? 99) - (b.minE ?? 99) ||
          a.chain.localeCompare(b.chain),
      )
    if (!routes.length) continue
    oapps.push({
      address: oapp,
      label: labels[oapp] ?? short(oapp),
      url: explorerAddressUrl(1, oapp),
      owner: holdersFor(oapp, 'owner'),
      delegate: holdersFor(oapp, 'delegate'),
      routes,
      liveRoutes: routes.filter((r) => r.live).length,
      closedRoutes: routes.filter((r) => !r.live).length,
      remoteRead: routes.filter((r) => r.remote && !r.remote.unread).length,
      remoteUnread: routes.filter((r) => r.remote?.unread).length,
    })
  }

  const dvns: DvnView[] = items
    .filter((i) => /^bridge\/dvn\/1\/0x[0-9a-f]{40}$/.test(i.key))
    .map((i) => {
      const address = i.key.split('/')[3]
      const v = (i.value ?? {}) as { quorum?: number | null; signers?: number | null }
      const name = i.display.match(/^DVN (.+): /)?.[1] ?? short(address)
      return {
        name,
        address,
        url: explorerAddressUrl(1, address),
        quorum: v.quorum ?? null,
        signers: v.signers ?? null,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
  // every non-LayerZero bridge line: CCIP pools, Wormhole NTT managers, canonical rollup bridges
  const ccip = items.filter((i) => /^bridge\/(ccip|ntt|canonical)\//.test(i.key)).map(itemView)
  return { oapps, dvns, ccip, warnings }
}

export function itemView(i: StateItem): ItemView {
  return {
    key: i.key,
    display: i.display,
    chainId: i.chainId,
    breaches: (i.breaches ?? []).map((b) => ({ ruleId: b.ruleId, message: b.message })),
    warnings: i.warnings ?? [],
  }
}

// ---- admin ------------------------------------------------------------------------------------

const POWER_LABEL: Record<PowerState['power'], string> = {
  upgrade: 'Upgrade',
  mint: 'Mint',
  bridge_config: 'Bridge config',
  oracle: 'Oracle',
  pause: 'Pause',
  caps: 'Caps',
  roles: 'Roles',
}

/** Powers with their state-rule breaches (items are emitted in the same order as powers). */
export function powerViews(
  powers: readonly PowerState[],
  items: readonly StateItem[],
): PowerView[] {
  const pool = items.filter((i) => i.key.startsWith('admin/power/'))
  const used = new Set<number>()
  return powers.map((p, idx) => {
    const key = `admin/power/${p.power}/${lc(p.contract)}`
    let j = pool[idx]?.key === key && !used.has(idx) ? idx : -1
    if (j < 0) j = pool.findIndex((i, n) => !used.has(n) && i.key === key)
    if (j >= 0) used.add(j)
    const breaches: BreachView[] =
      j >= 0
        ? (pool[j].breaches ?? []).map((b) => ({
            ruleId: b.ruleId,
            message: b.message,
            ...(b.unconfirmed ? { unconfirmed: b.unconfirmed.readGap } : {}),
          }))
        : []
    // the engine's notes on the power (bypass functions and holders, unclassified holders)
    const warnings = j >= 0 ? [...(pool[j].warnings ?? [])] : []
    return {
      power: p.power,
      label: p.label,
      holders: p.holders.length ? p.holders.map(holderView) : [holderView(null)],
      delaySec: p.effectiveDelaySec,
      delayLabel: delayLabel(p.effectiveDelaySec),
      pendingObservable: p.pendingObservable,
      pendingNote: p.pendingNote ?? null,
      breaches,
      warnings,
    }
  })
}

/** The header's effective delay per kind of power: the shortest over every power of that kind. */
export function delayChips(powers: readonly PowerState[]): DelayChip[] {
  const out = new Map<PowerState['power'], DelayChip>()
  for (const p of powers) {
    const d = p.effectiveDelaySec
    const cur = out.get(p.power)
    if (!cur) {
      out.set(p.power, {
        power: p.power,
        label: POWER_LABEL[p.power] ?? p.power,
        delaySec: d,
        delayLabel: delayLabel(d),
        pendingObservable: p.pendingObservable,
        powers: 1,
      })
      continue
    }
    cur.powers++
    cur.pendingObservable = cur.pendingObservable && p.pendingObservable
    // −1 (immutable) is the strongest; any real delay is shorter than "never".
    const shorter = cur.delaySec < 0 ? d >= 0 : d >= 0 && d < cur.delaySec
    if (shorter) {
      cur.delaySec = d
      cur.delayLabel = delayLabel(d)
    }
  }
  const order: PowerState['power'][] = [
    'upgrade',
    'mint',
    'bridge_config',
    'oracle',
    'pause',
    'caps',
    'roles',
  ]
  return order.map((k) => out.get(k)).filter((x): x is DelayChip => !!x)
}

// ---- the card -------------------------------------------------------------------------------------

/**
 * Review round 11 (RV11-1): the card's read gaps — the stored ones, plus any the CURRENT rules
 * find in the stored head controllers (`treeReadGaps`). Holder labels are rendered from the
 * stored trees with the current rules; a tree collected before a rule existed would otherwise
 * render "UNREAD … ranked as a plain contract" while the card counted no read gap.
 */
/** Reds the head state counted that the change rows read cannot show: counted, in effect (ST-06). */
export function withCarriedRed(c: ConfigCounts, carried = 0): ConfigCounts {
  if (!carried) return c
  return {
    ...c,
    redInEffect: c.redInEffect + carried,
    redTotal: c.redTotal + carried,
    openRed: c.openRed + carried,
  }
}

export function readGapsOf(state: SubjectState | null | undefined): string[] {
  const stored = state?.readGaps ?? []
  const have = new Set(stored)
  const found = treeReadGaps((state?.powers ?? []).flatMap((p) => p.holders))
  return [...stored, ...found.filter((g) => !have.has(g))]
}

export type BuildCardOptions = {
  /** Quiet historical rows to keep; 'all' returns the full history. */
  keep?: number | 'all'
}

export function buildConfigCard(inp: ConfigInputs, opt: BuildCardOptions = {}): ConfigCardView {
  const { subject, state } = inp
  // LZ metadata name, else the engine's chain key; capitalised, since the metadata mixes
  // "Arbitrum" with "bera" / "unichain".
  const eidName = (eid: number, fallback?: string): string => {
    const name = inp.eidNames?.[String(eid)] ?? fallback
    return name ? name.charAt(0).toUpperCase() + name.slice(1) : `eid ${eid}`
  }
  const symbol = subjectSymbol(subject.label)
  const slug = subjectSlug(subject)
  const oracleSlug = subject.oracleAssetKey ? subject.oracleAssetKey.toLowerCase() : null
  const all = [...inp.queue, ...inp.changes]
  const executors = executorsByTimelock(inp.changes)
  const items = state?.items ?? []
  const powers = state?.powers ?? []
  const readGaps = [...(inp.fileGaps ?? []), ...readGapsOf(state)]
  const counts = withCarriedRed(countsOf(items, all, readGaps), inp.carriedRed)
  const views = orderTimeline(
    all.map((c) => toChangeView(c, { executors, eidName: (e) => eidName(e) })),
  )
  const keep = opt.keep === 'all' ? Infinity : (opt.keep ?? HISTORICAL_KEEP)
  const trimmed = trimTimeline(views, keep)
  const labels: Record<string, string> = {}
  for (const c of subject.contracts) if (c.chainId === 1) labels[lc(c.address)] ??= c.label
  const bridge = buildBridge(items, powers, inp.changes, subject.lzOApps, eidName, labels)
  const ruleIds = new Set<string>()
  for (const r of trimmed.rows) r.ruleIds.forEach((x) => ruleIds.add(x))
  for (const b of breachesOf(items)) ruleIds.add(b.ruleId)
  const rules: Record<string, string> = {}
  for (const id of [...ruleIds].sort()) rules[id] = (RULES as Record<string, string>)[id] ?? id
  return {
    available: !!state,
    changesAvailable: all.length > 0,
    ...(state ? {} : { reason: 'collector output missing for this subject' }),
    subject: subject.key,
    label: subject.label,
    symbol,
    slug,
    oracleSlug,
    class: subject.class,
    asOf: state?.asOf ?? { block: 0, ts: 0 },
    scan: state?.scan ?? { from: 0, to: 0 },
    announcement: subject.govChannels.length ? 'not_checked' : 'no_gov_channel',
    govChannels: subject.govChannels.map(govChannelView),
    proposedSources: (state?.proposedSources ?? []).map((p) => ({
      kind: p.kind,
      status: p.status,
      note: p.note ?? null,
    })),
    counts,
    delays: delayChips(powers),
    breaches: breachesOf(items),
    bridge: { oapps: bridge.oapps, dvns: bridge.dvns, ccip: bridge.ccip },
    oracle: {
      oracleSlug,
      entries: inp.oracleEntries ?? 0,
      changes: all.filter((c) => c.dimension === 'oracle').length,
      // the collector reads oracle governance events only for a subject in the oracle catalog;
      // oracle rows in the change files are collected even when the state file is missing
      // (review round 7: the filter said "not collected" yet filtered 2 rows)
      collected: !!oracleSlug && (!!state || all.some((c) => c.dimension === 'oracle')),
      windowDays: state?.oracleWindow?.days ?? null,
    },
    admin: {
      powers: powerViews(powers, items),
      items: items
        .filter((i) => i.dimension === 'admin' && !i.key.startsWith('admin/power/'))
        .map(itemView),
    },
    mint: { items: items.filter((i) => i.dimension === 'mint_redeem').map(itemView) },
    timeline: {
      rows: trimmed.rows,
      historicalTotal: trimmed.historicalTotal,
      historicalShown: trimmed.historicalShown,
      complete: trimmed.historicalShown === trimmed.historicalTotal,
      totals: {
        all: views.length,
        red: views.filter((c) => c.red).length,
        byDimension: {
          bridge: views.filter((c) => c.dimension === 'bridge').length,
          oracle: views.filter((c) => c.dimension === 'oracle').length,
          admin: views.filter((c) => c.dimension === 'admin').length,
          mint_redeem: views.filter((c) => c.dimension === 'mint_redeem').length,
        },
      },
    },
    rules,
    notes: subject.notes ?? [],
    warnings: [...(state?.warnings ?? []), ...bridge.warnings],
    readGaps,
  }
}

export function buildConfigSummary(inp: ConfigInputs): ConfigTabSummary {
  const { subject, state } = inp
  return {
    subject: subject.key,
    slug: subjectSlug(subject),
    symbol: subjectSymbol(subject.label),
    label: subject.label,
    oracleSlug: subject.oracleAssetKey ? subject.oracleAssetKey.toLowerCase() : null,
    counts: withCarriedRed(
      countsOf(
        state?.items ?? [],
        [...inp.queue, ...inp.changes],
        [...(inp.fileGaps ?? []), ...readGapsOf(state)],
      ),
      inp.carriedRed,
    ),
    asOf: state?.asOf ?? null,
  }
}
