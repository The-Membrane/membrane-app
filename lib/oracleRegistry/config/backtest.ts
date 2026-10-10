// LayerZero config backtest over a committed fixture (the Kelp rsETH regression test).
//
// The rules are the production rules (uln.ts / bridgeRules.ts / lzReplay.ts) with NOTHING
// specific to Kelp: no subject, eid, block or date appears in them. The fixture is the raw
// event sequence and point reads; the evaluation block and the criteria are chosen by the
// caller (tests/unit/oracleRegistryConfigBacktest.test.ts, scripts/oracle-registry/config/
// backtest-kelp.mjs). Metadata is used for operator IDENTITY only: the `deprecated` flag
// reflects today and is ignored here (useDeprecated: false), and a DVN counts as known at a
// block only if it is listed AND had code at that block.
//
// Honest label: this is a REGRESSION test, not a detection study. The subject, contracts and
// the floor E < 2 were chosen knowing the outcome (critique, "The Kelp backtest is circular").

import type { ConfigChange, RouteState, UlnConfigRaw } from './types'
import { routeBreaches } from './bridgeRules'
import { replayLz, routeFromState, type LzEvent, type LzReplayState } from './lzReplay'
import {
  displayRoute,
  evaluateRoute,
  mergeUln,
  securityOf,
  type CodeOracle,
  type DvnRegistry,
  type EvalCtx,
  codeOracleFrom,
  type CodeProbe,
} from './uln'

import { compareValueAtRisk, formatUsdCompact, valueAtRisk, type Amount } from './value'
import type { ValueAtRisk } from './types'

export type { CodeProbe } from './uln'
export { codeOracleFrom } from './uln'

export type CompactMeta = {
  eids: Record<string, { chainKey: string; chainId: number | null; name: string }>
  chains: Record<
    string,
    {
      chainKey: string
      chainId: number | null
      libs: { send: string[]; receive: string[]; blocked: string[]; read: string[] }
      dead: string[]
      dvns: Record<string, { id: string; name: string; deprecated?: boolean }>
    }
  >
}

export type PointRead = {
  block: number
  eid: number
  direction: 'send' | 'receive'
  lib: string
  merged: UlnConfigRaw | null
  /**
   * Fail-closed audit (RC-14): whether the read succeeded, and whether a null `merged` is the
   * library's own "no DVN" revert. A null `merged` that is not `mergedReverted` is NOT READ — it
   * was evaluated as "reverted (no DVN)": a closed route, calmer than the truth.
   */
  ok?: boolean
  error?: string
  mergedReverted?: boolean
}

export type LzFixture = {
  version: 1
  subject: string
  oapp: string
  builtAt: string
  notes: string[]
  metadata: CompactMeta
  local: {
    chainId: number
    scan: { from: number; to: number }
    events: LzEvent[]
    codeProbes: Record<string, CodeProbe>
    pointReads: PointRead[]
  }
  remote?: {
    chainId: number
    eid: number
    localEid: number
    peer: string
    window: { from: number; to: number }
    seed: LzReplayState
    events: LzEvent[]
    codeProbes: Record<string, CodeProbe>
    /** Remote block at (about) the local evaluation block's timestamp, with point reads. */
    evalRead?: { block: number; reads: PointRead[] }
  }
  /**
   * Value behind the exploited route at the evaluation block (owner ruling #9): the adapter's
   * locked balance on Ethereum, the remote peer's supply at `remote.evalRead.block`, and the
   * token price (registry consensus at the block × the protocol's on-chain rate).
   */
  value?: {
    block: number
    locked: Amount | null
    remoteSupply: Amount | null
    priceUsd: number | null
    priceBasis: string
    notes: string[]
  }
}

/** The exploited route's value at risk at the evaluation block (from the fixture's reads). */
export function fixtureValueAtRisk(fx: LzFixture): ValueAtRisk | null {
  const v = fx.value
  if (!v) return null
  return valueAtRisk({
    locked: v.locked,
    remoteSupply: v.remoteSupply,
    priceUsd: v.priceUsd,
    priceBasis: v.priceBasis,
    unread: [
      ...(v.locked ? [] : ['Ethereum locked balance not read']),
      ...(v.remoteSupply ? [] : ['remote bridged supply not read']),
    ],
  })
}

export function registryFromMeta(meta: CompactMeta): DvnRegistry {
  const reg: DvnRegistry = { byChain: {}, dead: {}, libraries: {} }
  for (const c of Object.values(meta.chains)) {
    if (!c.chainId) continue
    reg.byChain[c.chainId] = c.dvns
    reg.dead[c.chainId] = c.dead
    reg.libraries[c.chainId] = c.libs
  }
  return reg
}

export type BacktestOutput = {
  evalBlock: number
  timeline: ConfigChange[]
  remoteTimeline: ConfigChange[]
  headAtEval: {
    eid: number
    direction: string
    live: boolean
    E: number
    display: string
    breaches: { ruleId: string; message: string }[]
  }[]
  remoteHeadAtEval: {
    eid: number
    direction: string
    live: boolean
    E: number
    display: string
    breaches: { ruleId: string; message: string }[]
    /** Fail-closed audit (RC-14): the point read was not read (a failed read, not a revert). */
    unread?: boolean
  }[]
  /** Replay vs on-chain point reads (critique fix #2: cross-check the merge against reads). */
  crossChecks: {
    chainId: number
    block: number
    eid: number
    direction: string
    replay: string
    read: string
    match: boolean
  }[]
}

const sameCfg = (r: RouteState, read: UlnConfigRaw | null) => {
  if (!read) return r.security.blocked && r.config.noDvn
  const m = mergeUln(read, undefined)
  return (
    m.required.join() === r.config.required.join() &&
    m.optional.join() === r.config.optional.join() &&
    m.optionalThreshold === r.config.optionalThreshold &&
    m.confirmations === r.config.confirmations
  )
}

export function runLzBacktest(fx: LzFixture, evalBlock: number): BacktestOutput {
  const registry = registryFromMeta(fx.metadata)
  const probes: Record<number, Record<string, CodeProbe>> = {
    [fx.local.chainId]: fx.local.codeProbes,
  }
  if (fx.remote) probes[fx.remote.chainId] = fx.remote.codeProbes
  const ctx: EvalCtx = { registry, code: codeOracleFrom(probes), useDeprecated: false }
  const eidName = (e: number) => fx.metadata.eids[String(e)]?.chainKey ?? String(e)

  const full = replayLz(fx.local.events, {
    announcement: 'no_gov_channel',
    subject: fx.subject,
    oapps: [fx.oapp],
    ctx,
    eidName,
  })
  const atEval = replayLz(fx.local.events, {
    announcement: 'no_gov_channel',
    subject: fx.subject,
    oapps: [fx.oapp],
    ctx,
    eidName,
    toBlock: evalBlock,
  })
  const headAtEval = atEval.routes.map((r) => ({
    eid: r.eid,
    direction: r.direction,
    live: r.live,
    E: r.Eeff,
    display: displayRoute(r),
    breaches: routeBreaches(r),
  }))

  const crossChecks: BacktestOutput['crossChecks'] = []
  for (const pr of fx.local.pointReads) {
    const st = replayLz(fx.local.events, {
      subject: fx.subject,
      oapps: [fx.oapp],
      ctx,
      toBlock: pr.block,
    }).state
    const r = routeFromState(st, fx.oapp, pr.eid, pr.direction, pr.block, ctx)
    crossChecks.push({
      chainId: fx.local.chainId,
      block: pr.block,
      eid: pr.eid,
      direction: pr.direction,
      replay: displayRoute(r),
      read: pr.merged
        ? `${pr.merged.requiredDVNs.length} required [${pr.merged.requiredDVNs.join(',')}] + ${pr.merged.optionalDVNThreshold}-of-${pr.merged.optionalDVNs.length} optional, ${pr.merged.confirmations} conf`
        : pr.mergedReverted
          ? 'reverted (no DVN)'
          : `NOT READ${pr.error ? ` (${pr.error})` : ''}`,
      // a point that was not read never "matches" (fail closed)
      match:
        (!!pr.merged || !!pr.mergedReverted) &&
        typeof pr.lib === 'string' &&
        sameCfg(r, pr.merged) &&
        r.lib === pr.lib.toLowerCase(),
    })
  }

  let remoteTimeline: ConfigChange[] = []
  let remoteHeadAtEval: BacktestOutput['remoteHeadAtEval'] = []
  if (fx.remote) {
    const rm = fx.remote
    const rep = replayLz(rm.events, {
      announcement: 'no_gov_channel',
      subject: fx.subject,
      oapps: [rm.peer],
      ctx,
      eidName,
      seed: rm.seed,
    })
    remoteTimeline = rep.changes
    if (rm.evalRead) {
      remoteHeadAtEval = rm.evalRead.reads.map((pr) => {
        // RC-14: a null config that is not the library's own revert is NOT READ — never "no DVN"
        if (!pr.merged && !pr.mergedReverted)
          return {
            eid: pr.eid,
            direction: pr.direction,
            live: true,
            E: 0,
            display: `NOT READ${pr.error ? ` (${pr.error})` : ''}`,
            breaches: [],
            unread: true,
          }
        const cfg = pr.merged ? mergeUln(pr.merged, undefined) : mergeUln(undefined, undefined)
        const r = evaluateRoute(
          {
            chainId: rm.chainId,
            oapp: rm.peer,
            eid: pr.eid,
            direction: pr.direction,
            block: rm.evalRead!.block,
            peer: rep.state.peers[rm.peer.toLowerCase()]?.[String(pr.eid)] ?? '0x',
            lib: pr.lib,
            libIsDefault: false,
            config: cfg,
          },
          ctx,
        )
        return {
          eid: pr.eid,
          direction: pr.direction,
          live: r.live,
          E: r.Eeff,
          display: displayRoute(r),
          breaches: routeBreaches(r),
        }
      })
    }
  }

  return {
    evalBlock,
    timeline: full.changes,
    remoteTimeline,
    headAtEval,
    remoteHeadAtEval,
    crossChecks,
  }
}

/** Criteria of the design §5, parameterised by the CALLER (rules never see them). */
export function kelpCriteria(
  out: BacktestOutput,
  p: { exploitedEid: number; controlEid: number; cutoffTs: number },
) {
  const onEid = (c: ConfigChange, eid: number) => c.route?.eid === eid
  const redBeforeCutoff = [...out.timeline, ...out.remoteTimeline].filter(
    (c) => c.red && onEid(c, p.exploitedEid) && (c.ts ?? Infinity) < p.cutoffTs,
  )
  const headBreach = out.headAtEval.filter(
    (r) => r.eid === p.exploitedEid && r.breaches.some((b) => b.ruleId === 'BR-2'),
  )
  const controlRed = out.timeline.filter(
    (c) => c.red && onEid(c, p.controlEid) && (c.block ?? 0) <= out.evalBlock,
  )
  // Owner ruling 2026-10-06 (#3): BR-6 stays STRICT — every peer re-point is red, and the
  // control route's 2025 re-point being red is correct. The criterion is therefore "Movement has
  // no red DVN changes": every red on the control route except a pure peer re-point.
  const PEER_ONLY = new Set(['BR-6'])
  const controlDvnRed = controlRed.filter((c) => c.ruleIds.some((r) => !PEER_ONLY.has(r)))
  const announced = [...out.timeline, ...out.remoteTimeline].filter((c) => c.unannounced !== null)
  return {
    redOnExploitedEidBeforeCutoff: {
      pass: redBeforeCutoff.length > 0,
      count: redBeforeCutoff.length,
      first: redBeforeCutoff[0]?.id,
      firstTs: redBeforeCutoff.reduce<number | null>(
        (m, c) => (c.ts !== undefined && (m === null || c.ts < m) ? c.ts : m),
        null,
      ),
    },
    exploitedEidFloorBreachAtEval: {
      pass: headBreach.length > 0,
      directions: headBreach.map((h) => h.direction),
    },
    /** "Movement has no red DVN changes" (gating). Peer re-points are listed apart: red by BR-6. */
    controlRouteNoRedDvnChanges: {
      pass: controlDvnRed.length === 0,
      red: controlDvnRed.map((c) => `${c.id} ${c.ruleIds.join('+')}`),
      peerRepointsRed: controlRed
        .filter((c) => c.ruleIds.every((r) => PEER_ONLY.has(r)))
        .map((c) => `${c.id} BR-6`),
    },
    unannouncedNullThroughout: { pass: announced.length === 0, trivial: true },
    crossChecksMatch: {
      pass: out.crossChecks.every((c) => c.match),
      checks: out.crossChecks.length,
    },
  }
}

/**
 * The honest framing of the result (owner ruling 2026-10-06, #5): how long the exploited route
 * would have shown red before the exploit, next to how many comparable OApps were red at the
 * evaluation block — a broad flag, not a discriminator.
 */
export type SeverityAtEval = {
  /** USD value behind the exploited route at the evaluation block (null = not read / priced). */
  usd: number | null
  basis: ValueAtRisk['basis']
  /** The subject's rank by value at risk among the comparable OApps that could be priced. */
  rankByValue: number | null
  priced: number
  ofOApps: number
}

/**
 * The subject's severity at the evaluation block: its exploited route's value at risk (fixture
 * reads) and its rank by value among the floor-breaching OApps of the base-rate study.
 */
export function kelpSeverity(
  fx: LzFixture,
  base: Pick<BaseRate, 'byValue' | 'oappsWithLiveUnderFloor'> | null,
): SeverityAtEval | null {
  const v = fixtureValueAtRisk(fx)
  if (!v && !base?.byValue) return null
  return {
    usd: v?.usd ?? null,
    basis: v?.basis ?? null,
    rankByValue: base?.byValue?.subject.rank ?? null,
    priced: base?.byValue?.priced ?? 0,
    ofOApps: base?.oappsWithLiveUnderFloor ?? 0,
  }
}

export function kelpFraming(
  crit: ReturnType<typeof kelpCriteria>,
  p: { exploitedEid: number; cutoffTs: number; evalBlock: number },
  base: Pick<BaseRate, 'oappsWithOverrides' | 'oappsWithLiveUnderFloor' | 'subject'> | null,
  severity: SeverityAtEval | null = null,
): {
  redDaysBeforeExploit: number | null
  baseRate: string | null
  severity: SeverityAtEval | null
  text: string
} {
  const first = crit.redOnExploitedEidBeforeCutoff.firstTs
  const days = first === null ? null : Math.floor((p.cutoffTs - first) / 86400)
  const share = base
    ? `${base.oappsWithLiveUnderFloor.toLocaleString('en-US')} of ${base.oappsWithOverrides.toLocaleString('en-US')} comparable OApps (${Math.round((100 * base.oappsWithLiveUnderFloor) / base.oappsWithOverrides)}%)`
    : null
  const sev = !severity
    ? 'The severity rank (value at risk behind each floor breach) was not computed for this run.'
    : [
        severity.usd === null
          ? 'The value at risk behind the exploited route could not be read or priced.'
          : `By the severity rank — the value at risk behind a route, the larger of the adapter's locked balance on Ethereum and the remote chain's bridged supply, priced with the registry consensus — the exploited route carried ${formatUsdCompact(severity.usd)} (${severity.basis === 'locked' ? 'locked on Ethereum' : 'bridged supply on the remote chain'}).`,
        severity.rankByValue !== null
          ? `Among the floor-breaching OApps whose value could be priced, this subject ranked #${severity.rankByValue} of the ${severity.priced.toLocaleString('en-US')} priced (${(severity.ofOApps - severity.priced).toLocaleString('en-US')} of ${severity.ofOApps.toLocaleString('en-US')} could not be priced: a token the registry does not price, or a native OFT with nothing locked on Ethereum).`
          : '',
        // owner ruling 2026-10-08 #14: an unread value sorts FIRST (fail closed)
        severity.rankByValue !== null && severity.ofOApps > severity.priced
          ? `A card sorts a floor breach whose value is unread FIRST, labelled "value unread" (fail closed), so those ${(severity.ofOApps - severity.priced).toLocaleString('en-US')} would be listed ahead of this subject.`
          : '',
      ]
        .filter(Boolean)
        .join(' ')
  const text = [
    days === null
      ? `The card would not have shown eid ${p.exploitedEid} red before the exploit.`
      : `The card would have shown the exploited route (eid ${p.exploitedEid}) red for ${days} days (${(days / 365).toFixed(1)} years) before the exploit, from the change that first put it under the floor.`,
    share
      ? `At block ${p.evalBlock.toLocaleString('en-US')} it would also have shown ${share} with at least one live route under the floor${base!.subject.rank ? `; this subject ranked #${base!.subject.rank} by number of such routes` : ''}. The floor is a broad flag, not a discriminator.`
      : 'The base rate across comparable OApps was not computed.',
    sev,
  ].join(' ')
  return { redDaysBeforeExploit: days, baseRate: share, severity, text }
}

// ---- base rate (critique: "report how many live routes have E<2 and where the subject ranks") ----

export type BaseRateInput = {
  chainId: number
  evalBlock: number
  /** Latest receive-library override per (oapp, eid) at or before evalBlock. */
  overrides: { oapp: string; eid: number; config: UlnConfigRaw }[]
  /** Receive-library default per eid at evalBlock. */
  defaults: Record<string, UlnConfigRaw>
  /** `${oapp}|${eid}` → peer set at evalBlock (null = could not be read). */
  live: Record<string, boolean | null>
}

export type BaseRate = {
  evalBlock: number
  oappsWithOverrides: number
  overriddenRoutes: number
  underFloorRoutes: number
  liveUnderFloorRoutes: number
  livenessUnknown: number
  oappsWithLiveUnderFloor: number
  subject: { oapp: string; liveUnderFloor: number; rank: number | null; ofOApps: number }
  top: { oapp: string; liveUnderFloor: number }[]
  /**
   * The severity rank (owner ruling #9) over the same OApps: USD value behind each OApp's
   * floor breaches (its locked balance on Ethereum, priced with the registry consensus).
   * Unpriced = a token the registry does not price, or a native OFT (nothing locked).
   */
  byValue?: {
    priced: number
    unpriced: number
    subject: { usd: number | null; rank: number | null }
    top: { oapp: string; usd: number; token: string | null; liveUnderFloor: number }[]
  }
}

/** Rank the floor-breaching OApps by USD value at risk (null = unpriced, ranked last / not at all). */
export function rankByValue(
  per: Record<string, number>,
  values: Record<string, { usd: number | null; token: string | null }>,
  subjectOApp: string,
): NonNullable<BaseRate['byValue']> {
  const oapps = Object.keys(per)
  const priced = oapps
    .filter((o) => values[o]?.usd !== null && values[o]?.usd !== undefined)
    .map((o) => ({
      oapp: o,
      usd: values[o].usd as number,
      token: values[o].token,
      liveUnderFloor: per[o],
    }))
    .sort((a, b) => compareValueAtRisk(a, b) || a.oapp.localeCompare(b.oapp))
  const idx = priced.findIndex((x) => x.oapp === subjectOApp.toLowerCase())
  return {
    priced: priced.length,
    unpriced: oapps.length - priced.length,
    subject: { usd: idx >= 0 ? priced[idx].usd : null, rank: idx >= 0 ? idx + 1 : null },
    top: priced.slice(0, 25),
  }
}

/**
 * Of every OApp that overrides its ReceiveUln302 config, how many run a LIVE route under the
 * floor at `evalBlock`, and where the subject ranks. Scope (stated, not hidden): receive side on
 * the default receive library only; OApps that only inherit defaults are not counted (in 2026
 * the LZ defaults are 2-of-2+), and a peer that cannot be read counts as unknown liveness.
 */
export function baseRate(
  inp: BaseRateInput,
  ctx: EvalCtx,
  subjectOApp: string,
  /** USD value at risk per OApp (lower-case), for the severity rank (owner ruling #9). */
  values?: Record<string, { usd: number | null; token: string | null }>,
): BaseRate {
  const per = new Map<string, number>()
  let under = 0
  let liveUnder = 0
  let unknown = 0
  for (const o of inp.overrides) {
    const cfg = mergeUln(o.config, inp.defaults[String(o.eid)])
    const sec = securityOf(cfg, inp.chainId, inp.evalBlock, ctx)
    if (sec.blocked || sec.E >= 2) continue
    under++
    const l = inp.live[`${o.oapp.toLowerCase()}|${o.eid}`]
    if (l === null || l === undefined) {
      unknown++
      continue
    }
    if (!l) continue
    liveUnder++
    per.set(o.oapp.toLowerCase(), (per.get(o.oapp.toLowerCase()) ?? 0) + 1)
  }
  const ranked = [...per.entries()].sort((a, b) => b[1] - a[1])
  const idx = ranked.findIndex(([o]) => o === subjectOApp.toLowerCase())
  return {
    evalBlock: inp.evalBlock,
    oappsWithOverrides: new Set(inp.overrides.map((o) => o.oapp.toLowerCase())).size,
    overriddenRoutes: inp.overrides.length,
    underFloorRoutes: under,
    liveUnderFloorRoutes: liveUnder,
    livenessUnknown: unknown,
    oappsWithLiveUnderFloor: ranked.length,
    subject: {
      oapp: subjectOApp.toLowerCase(),
      liveUnderFloor: per.get(subjectOApp.toLowerCase()) ?? 0,
      rank: idx >= 0 ? idx + 1 : null,
      ofOApps: ranked.length,
    },
    top: ranked.slice(0, 25).map(([oapp, n]) => ({ oapp, liveUnderFloor: n })),
    ...(values ? { byValue: rankByValue(Object.fromEntries(per), values, subjectOApp) } : {}),
  }
}

/** OApps with at least one live route under the floor at the block, with their route counts. */
export function liveUnderFloorOApps(inp: BaseRateInput, ctx: EvalCtx): Record<string, number> {
  const per: Record<string, number> = {}
  for (const o of inp.overrides) {
    const sec = securityOf(
      mergeUln(o.config, inp.defaults[String(o.eid)]),
      inp.chainId,
      inp.evalBlock,
      ctx,
    )
    if (sec.blocked || sec.E >= 2) continue
    if (inp.live[`${o.oapp.toLowerCase()}|${o.eid}`] !== true) continue
    per[o.oapp.toLowerCase()] = (per[o.oapp.toLowerCase()] ?? 0) + 1
  }
  return per
}
