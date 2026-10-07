// LayerZero V2 ULN arithmetic: the merged (effective) config of one (oapp, eid, library), the
// operator-aware verifier count E, and the evaluated state of one route direction.
//
// Merge semantics mirror UlnBase.getUlnConfig (LayerZero-v2 messagelib/contracts/uln/UlnBase.sol):
//   confirmations      0 → inherit the default; type(uint64).max (NIL) → explicitly ZERO
//   required/optional  count 0 → inherit the default; 255 (NIL) → explicitly none
//   no DVN at all      getUlnConfig reverts (AtLeastOneDVN) → the route verifies nothing
// The collector reads the library's own getUlnConfig at head; this merge is only used to
// REPLAY history and is cross-checked against the head read (critique fix #2).
//
// E is not "required + threshold". It is the minimum number of distinct KNOWN operators an
// attacker must compromise to forge a packet (critique fix #1):
//   - DVNs are deduped across required and optional before counting;
//   - an unknown DVN (not in LZ metadata for that chain, or without code at the block) is
//     free to an attacker — it adds nothing;
//   - two DVNs of one operator count once (canary / canary-subsidized fold together);
//   - optional picks are taken greedily from the cheapest operators (free ones first, then
//     operators already compromised through the required set, then the largest groups).

import type {
  Address,
  BlockedReason,
  Direction,
  DvnConfig,
  DvnInfo,
  Hex,
  LibraryKind,
  RouteState,
  Security,
  UlnConfigRaw,
} from './types'

export const NIL_DVN_COUNT = 255
export const NIL_CONFIRMATIONS = 18446744073709551615n // type(uint64).max
export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000'
export const ZERO_BYTES32 = '0x' + '0'.repeat(64)
/** The absolute floor: a live route needs at least this many distinct known operators. */
export const FLOOR_E = 2

export const lc = (a: string | null | undefined): string => String(a ?? '').toLowerCase()

export const EMPTY_ULN: UlnConfigRaw = {
  confirmations: '0',
  requiredDVNCount: 0,
  optionalDVNCount: 0,
  optionalDVNThreshold: 0,
  requiredDVNs: [],
  optionalDVNs: [],
}

/** Merge an OApp override with the library default exactly like UlnBase.getUlnConfig. */
export function mergeUln(
  custom: UlnConfigRaw | undefined,
  def: UlnConfigRaw | undefined,
): DvnConfig {
  const c = custom ?? EMPTY_ULN
  const d = def ?? EMPTY_ULN
  const fromDefault: boolean[] = []

  let confRaw: bigint
  const cConf = BigInt(c.confirmations || '0')
  if (cConf === 0n) {
    confRaw = BigInt(d.confirmations || '0')
    fromDefault.push(true)
  } else {
    confRaw = cConf === NIL_CONFIRMATIONS ? 0n : cConf
    fromDefault.push(false)
  }
  const explicitZero =
    cConf === NIL_CONFIRMATIONS || (cConf === 0n && confRaw === NIL_CONFIRMATIONS)
  if (confRaw === NIL_CONFIRMATIONS) confRaw = 0n

  let required: Address[] = []
  if (c.requiredDVNCount === 0) {
    if (d.requiredDVNCount > 0 && d.requiredDVNCount !== NIL_DVN_COUNT) required = d.requiredDVNs
    fromDefault.push(true)
  } else {
    if (c.requiredDVNCount !== NIL_DVN_COUNT) required = c.requiredDVNs
    fromDefault.push(false)
  }

  let optional: Address[] = []
  let threshold = 0
  if (c.optionalDVNCount === 0) {
    if (d.optionalDVNCount > 0 && d.optionalDVNCount !== NIL_DVN_COUNT) {
      optional = d.optionalDVNs
      threshold = d.optionalDVNThreshold
    }
    fromDefault.push(true)
  } else {
    if (c.optionalDVNCount !== NIL_DVN_COUNT) {
      optional = c.optionalDVNs
      threshold = c.optionalDVNThreshold
    }
    fromDefault.push(false)
  }

  const source = fromDefault.every(Boolean)
    ? 'default'
    : fromDefault.some(Boolean)
      ? 'mixed'
      : 'override'
  return {
    required: required.map(lc),
    optional: optional.map(lc),
    optionalThreshold: threshold,
    confirmations: confRaw.toString(),
    zeroConfirmations: confRaw === 0n || explicitZero,
    source,
    noDvn: required.length === 0 && threshold === 0,
  }
}

// ---- DVN registry (LZ metadata) ---------------------------------------------------------------

export type ChainLibs = { send: Address[]; receive: Address[]; blocked: Address[]; read: Address[] }

export type DvnRegistry = {
  /** chainId → dvn address → metadata row (id, canonicalName, deprecated). */
  byChain: Record<number, Record<Address, { id: string; name: string; deprecated?: boolean }>>
  /** chainId → LZ dead DVN(s) (a route whose config needs one never verifies). */
  dead: Record<number, Address[]>
  /** chainId → library allowlist from the LZ deployment metadata (critique fix #4). */
  libraries: Record<number, ChainLibs>
}

/** code(chainId, address, block) → has code at that block; null when unknown. */
export type CodeOracle = (chainId: number, address: Address, block: number) => boolean | null

export type EvalCtx = {
  registry: DvnRegistry
  code?: CodeOracle
  /**
   * The metadata `deprecated` flag reflects TODAY. Historical replays (the backtest) pass
   * false so hindsight never leaks into a past verdict; head reads pass true (tag only).
   */
  useDeprecated: boolean
}

// Sponsored / subsidised / per-asset variants are the same operator running another key set.
// Mantle's DVNs (mantle01–03, mantle-bank, mantlecross) are ONE operator (default the owner did
// not object to, 2026-10-06).
const OPERATOR_FOLDS: [RegExp, string][] = [
  [/^canary(-.+)?$/, 'canary'],
  [/^mantle(0\d|-bank|cross)$/, 'mantle'],
  [/^(.+)-(sponsored|subsidized|subsidised|new|staging)$/, '$1'],
]

export function normalizeOperator(id: string): string {
  const s = lc(id)
  for (const [re, to] of OPERATOR_FOLDS) if (re.test(s)) return s.replace(re, to)
  return s
}

/**
 * DVNs run by the token's own issuer (FBTC, USDT0, Ondo). They count as an INDEPENDENT operator
 * (default the owner did not object to, 2026-10-06) but every display labels them 'issuer-run':
 * the issuer can also mint, so its DVN is not an outside check on the issuer.
 */
export const ISSUER_RUN_OPERATORS: ReadonlySet<string> = new Set(['fbtc', 'usdt0', 'ondo'])

/** LayerZero's launch-era placeholder: defaults pointed at 0x…dead before LZDeadDVN existed. */
export const isPlaceholderDvn = (a: string) => /^0x0{36}dead$/i.test(a) || /^0x0{40}$/.test(a)

export function dvnInfo(ctx: EvalCtx, chainId: number, address: Address, block: number): DvnInfo {
  const a = lc(address)
  const row = ctx.registry.byChain[chainId]?.[a]
  const dead =
    (ctx.registry.dead[chainId] ?? []).map(lc).includes(a) ||
    row?.id === 'lz-dead-dvn' ||
    isPlaceholderDvn(a)
  const hasCode = ctx.code ? ctx.code(chainId, a, block) : null
  const known = !!row && !dead && hasCode !== false
  return {
    address: a,
    operator: known ? normalizeOperator(row!.id) : null,
    name: row?.name ?? null,
    deprecated: ctx.useDeprecated ? !!row?.deprecated : false,
    dead,
    hasCode,
  }
}

const dedupe = (xs: Address[]) => [...new Set(xs.map(lc))]

/** Operator-aware security of a merged config at a block on a chain. */
export function securityOf(cfg: DvnConfig, chainId: number, block: number, ctx: EvalCtx): Security {
  // A DVN listed as both required and optional signs once and counts for both: keep it in O
  // (it is a FREE optional pick for an attacker who already holds it through R).
  const R = dedupe(cfg.required)
  const O = dedupe(cfg.optional)
  const info = new Map([...R, ...O].map((a) => [a, dvnInfo(ctx, chainId, a, block)]))
  const get = (a: Address) => info.get(a)!

  const unknown = [...info.values()]
    .filter((i) => i.operator === null && !i.dead)
    .map((i) => i.address)
  // A dead DVN (LZDeadDVN, the 0x…dead placeholder) blocks the route; it is not "no code" risk.
  const noCode = [...info.values()]
    .filter((i) => i.hasCode === false && !i.dead)
    .map((i) => i.address)
  const dead = [...info.values()].filter((i) => i.dead).map((i) => i.address)
  const deprecated = [...info.values()].filter((i) => i.deprecated).map((i) => i.address)
  const byOp = new Map<string, Address[]>()
  for (const i of info.values())
    if (i.operator) byOp.set(i.operator, [...(byOp.get(i.operator) ?? []), i.address])
  const duplicateOperator = [...byOp.values()].filter((xs) => xs.length > 1).flat()

  const threshold = cfg.optionalThreshold
  const liveOptional = O.filter((a) => !get(a).dead)
  let blockedReason: BlockedReason | undefined
  if (cfg.noDvn) blockedReason = 'no_dvn'
  else if (R.some((a) => get(a).dead)) blockedReason = 'dead_dvn'
  else if (threshold > liveOptional.length)
    blockedReason = threshold > O.length ? 'threshold_unreachable' : 'dead_dvn'

  const reqOps = new Set(R.map((a) => get(a).operator).filter((o): o is string => !!o))
  let free = 0
  const groups = new Map<string, number>()
  for (const a of liveOptional) {
    const op = get(a).operator
    if (!op || reqOps.has(op)) free++
    else groups.set(op, (groups.get(op) ?? 0) + 1)
  }
  let need = Math.max(0, threshold - free)
  let extra = 0
  for (const size of [...groups.values()].sort((x, y) => y - x)) {
    if (need <= 0) break
    need -= size
    extra++
  }
  const E = blockedReason ? 0 : reqOps.size + extra

  const operators = [...new Set([...reqOps, ...groups.keys()])].sort()
  return {
    E,
    operators,
    issuerRun: operators.filter((o) => ISSUER_RUN_OPERATORS.has(o)),
    required: R.length,
    optional: O.length,
    threshold,
    unknown,
    noCode,
    duplicateOperator,
    deprecated,
    dead,
    blocked: !!blockedReason,
    blockedReason,
    confirmations: cfg.confirmations,
    zeroConfirmations: cfg.zeroConfirmations,
  }
}

// ---- libraries ---------------------------------------------------------------------------------

export function libraryKind(
  ctx: EvalCtx,
  chainId: number,
  lib: Address,
  direction: Direction,
): { kind: LibraryKind; allowed: boolean } {
  const L = ctx.registry.libraries[chainId]
  const a = lc(lib)
  if (!L) return { kind: 'unknown', allowed: false }
  if (L.blocked.map(lc).includes(a)) return { kind: 'blocked', allowed: true }
  if (L.read.map(lc).includes(a)) return { kind: 'read', allowed: true }
  const uln = direction === 'send' ? L.send : L.receive
  if (uln.map(lc).includes(a)) return { kind: 'uln', allowed: true }
  return { kind: 'unknown', allowed: false }
}

export const isZeroPeer = (peer: Hex | null | undefined) => !peer || /^0x0*$/i.test(peer)

/** bytes32 peer → EVM address when the top 12 bytes are zero (non-EVM peers return null). */
export function peerToAddress(peer: Hex): Address | null {
  const h = lc(peer).replace(/^0x/, '').padStart(64, '0')
  if (!/^0{24}/.test(h)) return null
  const a = '0x' + h.slice(24)
  return /^0x0{40}$/.test(a) ? null : a
}

export type RouteInputs = {
  chainId: number
  oapp: Address
  eid: number
  direction: Direction
  block: number
  peer: Hex
  lib: Address
  libIsDefault: boolean
  config: DvnConfig
  /** Receive only: the old library that still verifies, with its own merged config. */
  grace?: { lib: Address; expiry: number; config: DvnConfig }
  /** The library default's confirmations for this eid (LayerZero's finality guidance), if known. */
  defaultConfirmations?: string
}

/**
 * Security of one library for a route. BlockedMessageLib verifies nothing. A library outside
 * the LZ allowlist runs its own verification, so the DVN config says nothing about it: it
 * VERIFIES (it is not "closed") at E = 0 — BR-5 + the floor, never a calm "blocked".
 */
function librarySecurity(
  ctx: EvalCtx,
  chainId: number,
  lib: Address,
  direction: Direction,
  config: DvnConfig,
  block: number,
): { kind: LibraryKind; allowed: boolean; security: Security } {
  const { kind, allowed } = libraryKind(ctx, chainId, lib, direction)
  let security = securityOf(config, chainId, block, ctx)
  if (kind === 'blocked')
    security = { ...security, E: 0, blocked: true, blockedReason: 'blocked_library' }
  else if (!allowed)
    security = ctx.registry.libraries[chainId]
      ? { ...security, E: 0, blocked: false, blockedReason: undefined }
      : // no allowlist for the chain: the library cannot be judged; never more than E = 0
        { ...security, E: 0 }
  return { kind, allowed, security }
}

/** The route can verify a packet through its library OR the old library still in its grace period. */
export const routeVerifies = (r: Pick<RouteState, 'security' | 'grace'>): boolean =>
  !r.security.blocked || (!!r.grace && !r.grace.security.blocked)

/** Evaluate one route direction: library class, E, liveness, grace-period minimum. */
export function evaluateRoute(inp: RouteInputs, ctx: EvalCtx): RouteState {
  const { kind, allowed, security } = librarySecurity(
    ctx,
    inp.chainId,
    inp.lib,
    inp.direction,
    inp.config,
    inp.block,
  )
  let grace: RouteState['grace']
  if (
    inp.direction === 'receive' &&
    inp.grace &&
    inp.grace.expiry > inp.block &&
    lc(inp.grace.lib) !== lc(inp.lib)
  ) {
    const g = librarySecurity(
      ctx,
      inp.chainId,
      inp.grace.lib,
      'receive',
      inp.grace.config,
      inp.block,
    )
    grace = { lib: lc(inp.grace.lib), expiry: inp.grace.expiry, security: g.security }
  }
  // EndpointV2.isValidReceiveLibrary accepts the timeout library until expiry WHATEVER the
  // current library is — moving a route to BlockedMessageLib does not close it while the old
  // library is in its grace period (the old library's config still decides who can forge).
  const verifying = [
    security.blocked ? null : security.E,
    grace && !grace.security.blocked ? grace.security.E : null,
  ].filter((e): e is number => e !== null)
  const live = !isZeroPeer(inp.peer) && verifying.length > 0
  const Eeff = verifying.length ? Math.min(...verifying) : 0
  return {
    chainId: inp.chainId,
    oapp: lc(inp.oapp),
    eid: inp.eid,
    direction: inp.direction,
    lib: lc(inp.lib),
    libKind: kind,
    libAllowed: allowed,
    libIsDefault: inp.libIsDefault,
    peer: lc(inp.peer),
    live,
    config: inp.config,
    security,
    grace,
    Eeff,
    defaultConfirmations: inp.defaultConfirmations,
  }
}

/** "usdt0" → "usdt0 (issuer-run)" for an issuer-run operator. */
export const operatorDisplay = (ops: readonly string[], issuerRun: readonly string[] = []) =>
  ops.map((o) => (issuerRun.includes(o) ? `${o} (issuer-run)` : o))

/** Short human display: "2-of-2 (layerzero-labs, nethermind) · 15 conf". */
export function displayRoute(r: RouteState | undefined): string {
  if (!r) return 'none'
  const s = r.security
  if (s.blocked && r.grace && !r.grace.security.blocked) {
    // The current library verifies nothing, the old one still does until its expiry.
    const g = r.grace.security
    const shape =
      g.optional > 0 && g.threshold > 0
        ? `${g.required} required + ${g.threshold}-of-${g.optional} optional`
        : `${g.required}-of-${g.required}`
    return `E=${r.Eeff} · ${shape} (${g.operators.length ? operatorDisplay(g.operators, g.issuerRun).join(', ') : 'no known operator'}) · ${g.zeroConfirmations ? 'ZERO' : g.confirmations} conf · current library ${r.libKind === 'blocked' ? 'BlockedMessageLib' : `blocked (${s.blockedReason})`}, old library ${r.grace.lib} still verifies until block ${r.grace.expiry}`
  }
  if (r.libKind === 'blocked') return 'BlockedMessageLib (route closed)'
  if (s.blocked) {
    const latent = [
      s.unknown.length ? `${s.unknown.length} unknown DVN` : '',
      s.noCode.length ? `${s.noCode.length} DVN without code` : '',
    ].filter(Boolean)
    return `blocked (${s.blockedReason})${latent.length ? ' · ' + latent.join(' · ') : ''}`
  }
  const shape =
    s.optional > 0 && s.threshold > 0
      ? `${s.required} required + ${s.threshold}-of-${s.optional} optional`
      : `${s.required}-of-${s.required}`
  const ops = s.operators.length
    ? operatorDisplay(s.operators, s.issuerRun).join(', ')
    : 'no known operator'
  const extra = [
    s.unknown.length ? `${s.unknown.length} unknown DVN` : '',
    s.noCode.length ? `${s.noCode.length} DVN without code` : '',
    r.grace ? `grace lib E=${r.grace.security.E} until block ${r.grace.expiry}` : '',
    r.libAllowed ? '' : 'library NOT in LZ allowlist',
  ].filter(Boolean)
  return `E=${r.Eeff} · ${shape} (${ops}) · ${s.zeroConfirmations ? 'ZERO' : s.confirmations} conf${extra.length ? ' · ' + extra.join(' · ') : ''}`
}

/** A code-presence probe: first block with code (null = unknown), or never up to `checkedTo`. */
export type CodeProbe = {
  firstCode: number | null
  never?: boolean
  checkedTo?: number
  codeAt?: number
}

/** CodeOracle from probes: code at block b ⇔ first code ≤ b (no self-destruct after Cancun). */
export function codeOracleFrom(probes: Record<number, Record<string, CodeProbe>>): CodeOracle {
  return (chainId, address, block) => {
    const p = probes[chainId]?.[address.toLowerCase()]
    if (!p) return null
    if (p.never) return p.checkedTo !== undefined && block <= p.checkedTo ? false : null
    if (p.codeAt !== undefined) return block >= p.codeAt ? true : null
    return p.firstCode !== null ? block >= p.firstCode : null
  }
}
