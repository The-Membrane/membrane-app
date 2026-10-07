// Event-sequence replay of LayerZero V2 config for a set of OApps on one chain.
//
// Changes are built from the EVENT SEQUENCE, not from snapshot diffs (critique fix #5), so a
// flip A → B → A between two snapshots is still seen, and a dip inside one transaction is
// caught too. The effective config is keyed by (oapp, eid, LIBRARY): overrides are stored per
// library, so a library switch (or a DefaultReceiveLibrarySet that moves an OApp on the
// default) silently drops an OApp's override — the replay sees that because it recomputes
// the route from whatever library is selected after each event (critique fix #4).
//
// Inputs are decoded events (collector) plus an optional seed state (point reads at the scan
// start, used for remote chains where a full history scan is not affordable).

import type {
  Address,
  AnnouncementStatus,
  ChangeTag,
  ConfigChange,
  Direction,
  Hex,
  RouteState,
  UlnConfigRaw,
} from './types'
import { compareRoute, routeDiffers } from './bridgeRules'
import { tag, isRed } from './rules'
import {
  displayRoute,
  evaluateRoute,
  lc,
  mergeUln,
  routeVerifies,
  ZERO_ADDRESS,
  type EvalCtx,
  type RouteInputs,
} from './uln'

type Base = { chainId: number; block: number; logIndex: number; sub?: number; tx: Hex; ts?: number }
export type LzEvent = Base &
  (
    | { kind: 'peer'; oapp: Address; eid: number; peer: Hex }
    | { kind: 'uln'; lib: Address; oapp: Address; eid: number; config: UlnConfigRaw }
    | { kind: 'uln_default'; lib: Address; eid: number; config: UlnConfigRaw }
    | { kind: 'send_lib'; oapp: Address; eid: number; lib: Address }
    | { kind: 'recv_lib'; oapp: Address; eid: number; lib: Address }
    | { kind: 'recv_timeout'; oapp: Address; eid: number; lib: Address; expiry: number }
    | { kind: 'default_send_lib'; eid: number; lib: Address }
    | { kind: 'default_recv_lib'; eid: number; lib: Address }
    | { kind: 'default_recv_timeout'; eid: number; lib: Address; expiry: number }
    | { kind: 'delegate'; oapp: Address; delegate: Address }
  )

type Timeout = { lib: Address; expiry: number }
type ByEid<T> = Record<string, T>

export type LzReplayState = {
  chainId: number
  defaults: Record<Address, ByEid<UlnConfigRaw>>
  overrides: Record<Address, Record<Address, ByEid<UlnConfigRaw>>>
  defaultSendLib: ByEid<Address>
  defaultRecvLib: ByEid<Address>
  defaultRecvTimeout: ByEid<Timeout>
  sendLib: Record<Address, ByEid<Address>>
  recvLib: Record<Address, ByEid<Address>>
  recvTimeout: Record<Address, ByEid<Timeout>>
  peers: Record<Address, ByEid<Hex>>
  delegates: Record<Address, Address>
  /** (oapp, eid) pairs that ever had a peer or an override. */
  routes: string[]
}

export const emptyLzState = (chainId: number): LzReplayState => ({
  chainId,
  defaults: {},
  overrides: {},
  defaultSendLib: {},
  defaultRecvLib: {},
  defaultRecvTimeout: {},
  sendLib: {},
  recvLib: {},
  recvTimeout: {},
  peers: {},
  delegates: {},
  routes: [],
})

const isZeroAddr = (a: string | undefined) => !a || /^0x0{40}$/i.test(a)
const rk = (oapp: Address, eid: number) => `${lc(oapp)}|${eid}`

/** The inputs of one route direction under the replay state at `block` (evaluateRoute's argument). */
export function routeInputsFromState(
  s: LzReplayState,
  oapp: Address,
  eid: number,
  direction: Direction,
  block: number,
): RouteInputs {
  const o = lc(oapp)
  const e = String(eid)
  const own = direction === 'send' ? s.sendLib[o]?.[e] : s.recvLib[o]?.[e]
  const libIsDefault = isZeroAddr(own)
  const lib = libIsDefault
    ? ((direction === 'send' ? s.defaultSendLib[e] : s.defaultRecvLib[e]) ?? ZERO_ADDRESS)
    : own!
  const cfg = (l: Address) => mergeUln(s.overrides[lc(l)]?.[o]?.[e], s.defaults[lc(l)]?.[e])
  let grace: RouteInputs['grace']
  if (direction === 'receive') {
    const t = libIsDefault ? s.defaultRecvTimeout[e] : s.recvTimeout[o]?.[e]
    if (t && !isZeroAddr(t.lib) && t.expiry > block)
      grace = { lib: t.lib, expiry: t.expiry, config: cfg(t.lib) }
  }
  const defConf = s.defaults[lc(lib)]?.[e]?.confirmations
  return {
    chainId: s.chainId,
    oapp: o,
    eid,
    direction,
    block,
    peer: s.peers[o]?.[e] ?? '0x',
    lib,
    libIsDefault,
    config: cfg(lib),
    grace,
    defaultConfirmations:
      defConf === undefined ? undefined : mergeUln(undefined, s.defaults[lc(lib)][e]).confirmations,
  }
}

/** The effective state of one route direction under the replay state at `block`. */
export function routeFromState(
  s: LzReplayState,
  oapp: Address,
  eid: number,
  direction: Direction,
  block: number,
  ctx: EvalCtx,
): RouteState {
  return evaluateRoute(routeInputsFromState(s, oapp, eid, direction, block), ctx)
}

function noteRoute(s: LzReplayState, oapp: Address, eid: number) {
  const k = rk(oapp, eid)
  if (!s.routes.includes(k)) s.routes.push(k)
}

function apply(s: LzReplayState, ev: LzEvent, tracked: Set<string>): string[] {
  const set = <T>(m: Record<string, ByEid<T>>, a: string, eid: number, v: T) => {
    m[lc(a)] = m[lc(a)] ?? {}
    m[lc(a)][String(eid)] = v
  }
  const isTracked = (o: string) => tracked.size === 0 || tracked.has(lc(o))
  const routesWithEid = (eid: number) => s.routes.filter((r) => r.endsWith(`|${eid}`))
  switch (ev.kind) {
    case 'peer':
      if (!isTracked(ev.oapp)) return []
      set(s.peers, ev.oapp, ev.eid, lc(ev.peer))
      noteRoute(s, ev.oapp, ev.eid)
      return [rk(ev.oapp, ev.eid)]
    case 'uln': {
      if (!isTracked(ev.oapp)) return []
      const l = lc(ev.lib)
      s.overrides[l] = s.overrides[l] ?? {}
      set(s.overrides[l], ev.oapp, ev.eid, ev.config)
      noteRoute(s, ev.oapp, ev.eid)
      return [rk(ev.oapp, ev.eid)]
    }
    case 'uln_default':
      s.defaults[lc(ev.lib)] = s.defaults[lc(ev.lib)] ?? {}
      s.defaults[lc(ev.lib)][String(ev.eid)] = ev.config
      return routesWithEid(ev.eid)
    case 'send_lib':
      if (!isTracked(ev.oapp)) return []
      set(s.sendLib, ev.oapp, ev.eid, lc(ev.lib))
      noteRoute(s, ev.oapp, ev.eid)
      return [rk(ev.oapp, ev.eid)]
    case 'recv_lib':
      if (!isTracked(ev.oapp)) return []
      set(s.recvLib, ev.oapp, ev.eid, lc(ev.lib))
      noteRoute(s, ev.oapp, ev.eid)
      return [rk(ev.oapp, ev.eid)]
    case 'recv_timeout':
      if (!isTracked(ev.oapp)) return []
      set(s.recvTimeout, ev.oapp, ev.eid, { lib: lc(ev.lib), expiry: ev.expiry })
      return [rk(ev.oapp, ev.eid)]
    case 'default_send_lib':
      s.defaultSendLib[String(ev.eid)] = lc(ev.lib)
      return routesWithEid(ev.eid)
    case 'default_recv_lib':
      s.defaultRecvLib[String(ev.eid)] = lc(ev.lib)
      return routesWithEid(ev.eid)
    case 'default_recv_timeout':
      s.defaultRecvTimeout[String(ev.eid)] = { lib: lc(ev.lib), expiry: ev.expiry }
      return routesWithEid(ev.eid)
    case 'delegate':
      if (!isTracked(ev.oapp)) return []
      s.delegates[lc(ev.oapp)] = lc(ev.delegate)
      return []
  }
}

/** Route keys an event can move, computed without mutating the state. */
function touchedBy(s: LzReplayState, ev: LzEvent, tracked: Set<string>): string[] {
  const isTracked = (o: string) => tracked.size === 0 || tracked.has(lc(o))
  switch (ev.kind) {
    case 'uln_default':
    case 'default_send_lib':
    case 'default_recv_lib':
    case 'default_recv_timeout':
      return s.routes.filter((r) => r.endsWith(`|${ev.eid}`))
    case 'delegate':
      return []
    default:
      return isTracked(ev.oapp) ? [rk(ev.oapp, ev.eid)] : []
  }
}

export const sortEvents = <T extends Base>(evs: T[]) =>
  [...evs].sort(
    (a, b) => a.block - b.block || a.logIndex - b.logIndex || (a.sub ?? 0) - (b.sub ?? 0),
  )

export type DelegateChange = {
  chainId: number
  oapp: Address
  prev: Address | null
  next: Address
  block: number
  tx: Hex
  logIndex: number
  ts?: number
}

export type ReplayOptions = {
  subject: string
  /** OApps whose routes become changes (the default/library events are global). */
  oapps: Address[]
  ctx: EvalCtx
  /** Stop after this block (inclusive): the backtest evaluates history as of a past head. */
  toBlock?: number
  /** Window for cross-transaction flash detection (BR-9). */
  flashBlocks?: number
  eidName?: (eid: number) => string
  seed?: LzReplayState
  /** The subject's announcement status (NO-GOV-CHANNEL vs not checked); never "announced". */
  announcement?: AnnouncementStatus
}

export type ReplayResult = {
  state: LzReplayState
  /** Last state of each route direction (`${oapp}|${eid}|${direction}`) that could verify. */
  lastVerifying: Record<string, RouteState>
  /** Last NON-ZERO peer of each route direction (a re-point through a zeroed peer is BR-6). */
  lastPeer: Record<string, string>
  changes: ConfigChange[]
  delegateChanges: DelegateChange[]
  /** Final route states for every tracked (oapp, eid, direction) at the last replayed block. */
  routes: RouteState[]
  lastBlock: number
}

export const routeKey = (r: {
  chainId: number
  oapp: Address
  eid: number
  direction: Direction
}) => `bridge/lz/${r.chainId}/${lc(r.oapp)}/${r.eid}/${r.direction}`

/** Replay `events` (any order) and emit one ConfigChange per (tx, route direction) that moved. */
export function replayLz(events: LzEvent[], opts: ReplayOptions): ReplayResult {
  const ctx = opts.ctx
  const flash = opts.flashBlocks ?? 7200
  const tracked = new Set(opts.oapps.map(lc))
  const chainId = opts.seed?.chainId ?? events[0]?.chainId ?? 1
  const s: LzReplayState = opts.seed ? JSON.parse(JSON.stringify(opts.seed)) : emptyLzState(chainId)
  const evs = sortEvents(
    events.filter(
      (e) => e.chainId === chainId && (opts.toBlock === undefined || e.block <= opts.toBlock),
    ),
  )
  const changes: ConfigChange[] = []
  const delegateChanges: DelegateChange[] = []
  const eidName = opts.eidName ?? ((e: number) => String(e))
  // For BR-9: last downgrade per route key → the Eeff it came down from.
  const lastDown = new Map<string, { block: number; fromE: number; change: ConfigChange }>()
  // The last state of each route direction that could verify a packet: a route reopened from
  // BlockedMessageLib / a dead DVN is compared with the config it last ran with (BR-1).
  const lastVerifying = new Map<string, RouteState>()
  // The last non-zero peer of each route direction: A → 0 → B is a re-point (BR-6, strict).
  const lastPeer = new Map<string, string>()
  const notePeer = (k: string, r: RouteState) => {
    if (!/^0x0*$/i.test(r.peer)) lastPeer.set(k, r.peer)
  }
  let lastBlock = 0

  const dirs: Direction[] = ['send', 'receive']
  const snapshot = (keys: string[], block: number) => {
    const m = new Map<string, RouteState>()
    for (const k of keys) {
      const [o, e] = k.split('|')
      for (const d of dirs) m.set(`${k}|${d}`, routeFromState(s, o, Number(e), d, block, ctx))
    }
    return m
  }
  const closedOr = (r: RouteState) => (routeVerifies(r) ? `E=${r.Eeff}` : 'blocked')

  let i = 0
  while (i < evs.length) {
    const tx = evs[i].tx
    const block = evs[i].block
    const group: LzEvent[] = []
    while (i < evs.length && evs[i].tx === tx && evs[i].block === block) group.push(evs[i++])
    lastBlock = block

    // Routes this tx can touch (a default event touches every tracked route on that eid).
    const touch = new Set<string>()
    for (const ev of group) for (const k of touchedBy(s, ev, tracked)) touch.add(k)
    const keys = [...touch].filter((k) => tracked.size === 0 || tracked.has(k.split('|')[0]))
    const before = snapshot(
      keys.filter((k) => s.routes.includes(k)),
      block,
    )
    for (const [k, b] of before) {
      if (routeVerifies(b)) lastVerifying.set(k, b)
      notePeer(k, b)
    }
    const peerBefore = new Map(
      keys.flatMap((k) => dirs.map((d) => `${k}|${d}`)).map((k) => [k, lastPeer.get(k)]),
    )

    // Inside a multi-event transaction every intermediate state is judged too (BR-9): an E dip,
    // a peer flipped A → B → A, confirmations set to NIL and back — a forged packet can be
    // verified in between although the net change is nothing.
    const minE = new Map<string, number>()
    const stepDown = new Map<string, { prev: RouteState; note: string }[]>()
    const step = new Map(before)
    for (const ev of group) {
      if (ev.kind === 'delegate' && (tracked.size === 0 || tracked.has(lc(ev.oapp)))) {
        delegateChanges.push({
          chainId,
          oapp: lc(ev.oapp),
          prev: s.delegates[lc(ev.oapp)] ?? null,
          next: lc(ev.delegate),
          block,
          tx,
          logIndex: ev.logIndex,
          ts: ev.ts,
        })
      }
      const ks = apply(s, ev, tracked).filter((k) => keys.includes(k))
      if (group.length > 1)
        for (const [k, r] of snapshot(ks, block)) {
          if (r.live) minE.set(k, Math.min(minE.get(k) ?? Infinity, r.Eeff))
          const prev = step.get(k)
          if (prev && routeDiffers(prev, r)) {
            const sv = compareRoute(prev, r, lastVerifying.get(k), peerBefore.get(k))
            if (sv.severity === 'downgrade')
              stepDown.set(k, [
                ...(stepDown.get(k) ?? []),
                { prev, note: `${sv.ruleIds.join('+')}: ${sv.notes.join('; ')}` },
              ])
          }
          step.set(k, r)
          if (prev) notePeer(k, prev)
        }
    }
    const after = snapshot(keys, block)

    for (const [k, a] of after) {
      const b = before.get(k)
      const lo = minE.get(k)
      const ends = Math.min(b?.live ? b.Eeff : Infinity, a.live ? a.Eeff : Infinity)
      const dipped = lo !== undefined && lo < ends
      // a weaker step whose effect the transaction undid (the end state is not weaker than the
      // state before that step) — a weakening that persists is the net change, not a flash
      const flipped = (stepDown.get(k) ?? [])
        .filter(
          (x) =>
            compareRoute(x.prev, a, lastVerifying.get(k), peerBefore.get(k)).severity !==
            'downgrade',
        )
        .map((x) => x.note)
      // A set-and-revert inside one transaction leaves no net change but is still a change.
      if (!routeDiffers(b, a) && !dipped && !flipped.length) {
        notePeer(k, a)
        continue
      }
      const v = compareRoute(b, a, lastVerifying.get(k), peerBefore.get(k))
      if (dipped) {
        v.severity = 'downgrade'
        if (!v.ruleIds.includes('BR-9')) v.ruleIds.push('BR-9')
        tag(v, 'flash')
        v.notes.push(`E dipped to ${lo} inside the transaction`)
      }
      if (flipped.length && v.severity !== 'downgrade') {
        v.severity = 'downgrade'
        if (!v.ruleIds.includes('BR-9')) v.ruleIds.push('BR-9')
        tag(v, 'flash')
        v.notes.push(
          `weaker config inside the transaction, reverted before it ended (${flipped.join(' | ')})`,
        )
      }
      if (group.some((g) => g.kind === 'uln_default' || g.kind.startsWith('default_')))
        tag(v, 'default_change')
      const first = group[0]
      const change: ConfigChange = {
        id: `${chainId}:${tx}:${first.logIndex}:${a.oapp}:${a.eid}:${a.direction}`,
        subject: opts.subject,
        dimension: 'bridge',
        key: routeKey(a),
        title: `${a.direction === 'receive' ? 'Receive' : 'Send'} config, eid ${a.eid} (${eidName(a.eid)}): ${b ? closedOr(b) : 'new'} → ${closedOr(a)}`,
        before: b ? compactRoute(b) : undefined,
        after: compactRoute(a),
        beforeDisplay: b ? displayRoute(b) : undefined,
        afterDisplay: displayRoute(a),
        state: 'historical',
        stage: 'executed',
        severity: v.severity,
        floorBreach: v.floorBreach,
        red: isRed(v),
        ruleIds: v.ruleIds,
        tags: v.tags as ChangeTag[],
        unannounced: null,
        announcement: opts.announcement ?? 'not_checked',
        chainId,
        block,
        ts: first.ts,
        tx,
        route: { chainId, oapp: a.oapp, eid: a.eid, direction: a.direction },
        notes: v.notes.length ? v.notes : undefined,
      }
      // Cross-transaction flash: a downgrade restored within `flash` blocks.
      const prior = lastDown.get(k)
      if (
        prior &&
        block - prior.block <= flash &&
        a.Eeff >= prior.fromE &&
        v.severity !== 'downgrade'
      ) {
        if (!prior.change.ruleIds.includes('BR-9')) prior.change.ruleIds.push('BR-9')
        if (!prior.change.tags.includes('flash')) prior.change.tags.push('flash')
        change.tags.push('flash')
        lastDown.delete(k)
      }
      // Only an E drop can be "flashed back"; other downgrades are not restorations.
      if (v.ruleIds.includes('BR-1') && b) lastDown.set(k, { block, fromE: b.Eeff, change })
      changes.push(change)
      if (routeVerifies(a)) lastVerifying.set(k, a)
      notePeer(k, a)
    }
  }

  const finalBlock = opts.toBlock ?? lastBlock
  const routes = [
    ...snapshot(
      s.routes.filter((k) => tracked.size === 0 || tracked.has(k.split('|')[0])),
      finalBlock,
    ).values(),
  ]
  return {
    state: s,
    lastVerifying: Object.fromEntries(lastVerifying),
    lastPeer: Object.fromEntries(lastPeer),
    changes,
    delegateChanges,
    routes,
    lastBlock: finalBlock,
  }
}

/** The compact, JSON-friendly part of a RouteState stored on a change. */
export function compactRoute(r: RouteState) {
  return {
    lib: r.lib,
    libKind: r.libKind,
    peer: r.peer,
    live: r.live,
    E: r.Eeff,
    required: r.config.required,
    optional: r.config.optional,
    threshold: r.config.optionalThreshold,
    confirmations: r.config.confirmations,
    source: r.config.source,
    operators: r.security.operators,
    blocked: r.security.blocked ? r.security.blockedReason : undefined,
    grace: r.grace
      ? { lib: r.grace.lib, expiry: r.grace.expiry, E: r.grace.security.E }
      : undefined,
  }
}
