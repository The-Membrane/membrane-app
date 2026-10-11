/**
 * position-alert-signal-backtest.ts — back-test the three signal sources wired in Q16:
 *
 *   1. Exit capacity on the spec's E3 venue (Aave v3 Core USDC through the rsETH lock), from
 *      the Recall Coverage Dataset's pinned per-block table, with and without the capacity
 *      burn term, and its calm rate on three years of hourly Aave Core USDC capacity.
 *   2. Oracle change: the oracle registry's change histories through the direction-aware
 *      adapter (fromRegistryChange), as messages per asset-month.
 *   3. LST depeg on a synchronous source: the Chainlink STETH/ETH feed, hourly from 2021-08.
 *
 *   pnpm tsx scripts/research/position-alert-signal-backtest.ts
 *
 * Inputs: the private datasets repo (board rule N18; $MEMBRANE_DATASETS_DIR, default
 * ../membrane-datasets): recall-coverage/data/chain/e3, venue-stress/history.json,
 * oracle-registry/{changes.json, snapshots, config/changes}, price-history/steth-eth-1h.json.
 * Output: docs/research/position-alerts-signal-results.json (no wallet data in any input).
 * Deterministic: no network.
 */

import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { datasetsDir } from '../lib/datasetsDir.mjs'

import {
  CAPACITY_BURN_PRESET,
  DEFAULT_ALERT_CONFIG,
  evaluate,
  fromRegistryChange,
  initialEngineState,
  isNotifiable,
  quantile,
  venueStressCapacity,
  type AlertConfig,
  type OracleChangeEvent,
  type PositionSnapshot,
  type RegistryChangeKind,
  type RegistryChangeLike,
  type VenueStressHistoryLike,
} from '../../lib/positionAlerts'

const ROOT = process.cwd()
const DS = datasetsDir(ROOT)
const OUT = join(ROOT, 'docs', 'research', 'position-alerts-signal-results.json')
const H = 3600
const D = 86400
const MONTH = 30 * D
const iso = (t: number | null) =>
  t === null ? null : new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')
const round = (v: number | null, dp = 3) => (v === null || !Number.isFinite(v) ? null : +v.toFixed(dp))
const readJson = (p: string) => JSON.parse(readFileSync(join(DS, p), 'utf8'))
const readJsonl = (p: string) => {
  const buf = readFileSync(join(DS, p))
  return (p.endsWith('.gz') ? gunzipSync(buf) : buf)
    .toString('utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l))
}

const OFF: AlertConfig = {
  healthFactor: null,
  ltv: null,
  liquidationDistance: null,
  cushionBurn: null,
  depeg: null,
  exitCapacity: null,
  oracleChange: null,
  targetHf: DEFAULT_ALERT_CONFIG.targetHf,
}

// ------------------------------------------------------------------ 1. exit capacity

const EXIT = DEFAULT_ALERT_CONFIG.exitCapacity!
const NEEDS = [10e6, 50e6, 100e6, 250e6]

/** A modelled position whose recall need under the rule's shock is exactly needUsd. */
function recallPosition(needUsd: number, ts: number): PositionSnapshot {
  const lt = 0.83
  const amount = 1_000_000_000
  const weightedShocked = amount * (1 - EXIT.shock) * lt
  return {
    id: `recall-${needUsd}`,
    ts,
    venue: 'Membrane (modelled)',
    collateral: [{ symbol: 'ETH', amount, oraclePriceUsd: 1, liquidationThreshold: lt }],
    debt: [{ symbol: 'USD', amount: needUsd + weightedShocked / EXIT.targetHf, priceUsd: 1 }],
  }
}

type Cap = [ts: number, usd: number]

/** Replay one recall size over a capacity path; first warn+ message per signal key. */
function capacityRun(path: Cap[], needUsd: number, config: AlertConfig) {
  let state = initialEngineState()
  const first: Record<string, number | null> = { recall: null, burn: null, any: null }
  let warnMessages = 0
  const byKey: Record<string, number> = {}
  for (const [ts, usd] of path) {
    const r = evaluate(
      recallPosition(needUsd, ts),
      { capacity: [{ venue: 'aave-core-usdc', availableUsd: usd, asOf: ts, provenance: 'replay' }] },
      state,
      config,
    )
    state = r.state
    for (const a of r.alerts.filter((x) => isNotifiable(x))) {
      if (a.severity === 'watch' || a.transition === 'clear') continue
      warnMessages++
      byKey[a.key] = (byKey[a.key] ?? 0) + 1
      if (first[a.key] === null) first[a.key] = a.ts
      if (first.any === null) first.any = a.ts
    }
  }
  return { first, warnMessages, byKey }
}

// E3: the pinned per-block Core USDC virtual underlying balance (withdrawable USDC).
const e3Util = readJsonl('recall-coverage/data/chain/e3/usdc_utilization.jsonl.gz') as {
  block: number
  ts: number
  vub_raw: string
  utilization: number
}[]
e3Util.sort((a, b) => a.block - b.block)
const e3Anchors = Object.fromEntries(
  (readJsonl('recall-coverage/data/chain/e3/anchors.jsonl') as { name: string; ts: number; block: number }[]).map(
    (a) => [a.name, a],
  ),
)
const E3_EXPLOIT = e3Anchors.start_exploit.ts
const E3_FULL_LOCK = e3Util.find((r) => r.ts >= E3_EXPLOIT && r.utilization >= 0.999)?.ts ?? null
/** One reading per 5 minutes (the last state-changing block in each), as a monitor would poll. */
function downsample(rows: { ts: number; usd: number }[], stepS: number): Cap[] {
  const out: Cap[] = []
  for (const r of rows) {
    const b = Math.ceil(r.ts / stepS) * stepS
    if (out.length && out[out.length - 1][0] === b) out[out.length - 1][1] = r.usd
    else {
      // carry the last value over empty buckets
      if (out.length) for (let t = out[out.length - 1][0] + stepS; t < b; t += stepS) out.push([t, out[out.length - 1][1]])
      out.push([b, r.usd])
    }
  }
  return out
}
const e3Path = downsample(
  e3Util.map((r) => ({ ts: r.ts, usd: Number(r.vub_raw) / 1e6 })),
  300,
)

function e3Runs(config: AlertConfig) {
  return NEEDS.map((need) => {
    const firstShort = e3Path.find(([ts, usd]) => ts >= E3_EXPLOIT && usd < need)?.[0] ?? null
    const r = capacityRun(e3Path, need, config)
    const lead = (t: number | null, ref: number | null) => (t !== null && ref !== null ? round((ref - t) / H, 2) : null)
    return {
      needUsd: need,
      firstShort: iso(firstShort),
      firstWarn: { recall: iso(r.first.recall), burn: iso(r.first.burn) },
      leadBeforeShortH: { any: lead(r.first.any, firstShort), recall: lead(r.first.recall, firstShort), burn: lead(r.first.burn, firstShort) },
      leadBeforeFullLockH: { any: lead(r.first.any, E3_FULL_LOCK), recall: lead(r.first.recall, E3_FULL_LOCK), burn: lead(r.first.burn, E3_FULL_LOCK) },
      warnMessages: r.warnMessages,
      preExploitWarns: capacityRun(e3Path.filter(([t]) => t < E3_EXPLOIT), need, config).warnMessages,
    }
  })
}

// Calm: three years of hourly Aave Core USDC capacity, outside every stress window.
const vs = readJson('venue-stress/history.json') as VenueStressHistoryLike & {
  timeline: { t: number[]; dense: number[] }
}
const vsSource = venueStressCapacity(vs, { 'aave-core-usdc': 1 }, 'venue-stress-history/v1')
const vsHours = vs.timeline.t
/** Hours outside the dense stress windows and outside E3 (the exploit to the end of the lock). */
const E3_END = e3Anchors.end.ts
const calmHour = (i: number) =>
  vs.timeline.dense[i] !== 1 && !(vsHours[i] >= E3_EXPLOIT - D && vsHours[i] <= E3_END + D)
function calmSegments(): Cap[][] {
  const segs: Cap[][] = []
  let cur: Cap[] = []
  vsHours.forEach((t, i) => {
    const r = calmHour(i) ? vsSource.readingAt('aave-core-usdc', t) : null
    if (r && r.asOf === t) cur.push([t, r.availableUsd])
    else if (cur.length) {
      segs.push(cur)
      cur = []
    }
  })
  if (cur.length) segs.push(cur)
  return segs.filter((s) => s.length >= 48)
}
const calmSegs = calmSegments()
const calmHours = calmSegs.reduce((a, s) => a + s.length, 0)
/** The spec's calm window: the 30 days before the E3 exploit. */
const preE3: Cap[] = vsHours
  .map((t, i) => [t, i] as const)
  .filter(([t]) => t >= E3_EXPLOIT - 30 * D - D && t < E3_EXPLOIT - D)
  .map(([t]) => [t, vsSource.readingAt('aave-core-usdc', t)?.availableUsd ?? NaN] as Cap)
  .filter(([, usd]) => Number.isFinite(usd))

function calmRate(config: AlertConfig) {
  return NEEDS.map((need) => {
    let msgs = 0
    const byKey: Record<string, number> = {}
    for (const seg of calmSegs) {
      const r = capacityRun(seg, need, config)
      msgs += r.warnMessages
      for (const [k, n] of Object.entries(r.byKey)) byKey[k] = (byKey[k] ?? 0) + n
    }
    const pre = capacityRun(preE3, need, config)
    const months = calmHours / (MONTH / H)
    return {
      needUsd: need,
      warnPlusPerMonth: round(msgs / months, 3),
      byKey,
      byKeyPerMonth: Object.fromEntries(Object.entries(byKey).map(([k, n]) => [k, round(n / months, 3)])),
      preE3Calm30d: { warnPlus: pre.warnMessages, byKey: pre.byKey },
    }
  })
}

const burnCfg = (lookbackH: number, warn: number): AlertConfig => ({
  ...OFF,
  exitCapacity: {
    ...EXIT,
    burn: {
      lookbackS: lookbackH * H,
      spec: {
        ...CAPACITY_BURN_PRESET.spec,
        enter: { watch: +(warn * 0.6).toFixed(2), warn, critical: Math.min(0.95, +(warn + 0.3).toFixed(2)) },
      },
    },
  },
})

// ------------------------------------------------------------------ 2. oracle change

/** Governance-log event names of the registry → its ChangeItem kind. */
const LOG_KIND: Record<string, RegistryChangeKind> = {
  Upgraded: 'upgrade',
  TollGranted: 'access',
  TollRenounced: 'access',
  CapParametersUpdated: 'cap',
  DiscountRatePerYearUpdated: 'discount',
  AssetSourceUpdated: 'market_source',
}

/** Parameter → registry ChangeKind. A copy of classifyParam (lib/oracleRegistry/changes.ts at d1d2ca4). */
function classifyParam(param: string): RegistryChangeKind {
  const p = param.toLowerCase()
  if (p.startsWith('source:') || p === 'currentoracle') return 'market_source'
  if (p.startsWith('component:')) return 'wiring'
  if (p === 'aggregator' || p === 'phaseid') return 'aggregator'
  if (p.includes('heartbeat')) return 'heartbeat'
  if (p.includes('deviation')) return 'deviation_threshold'
  if (p.includes('twap') || p.includes('window')) return 'twap_window'
  if (p.includes('discount')) return 'discount'
  if (p.includes('cap') || p.includes('snapshot') || p.includes('growth')) return 'cap'
  if (p === 'bar') return 'quorum'
  if (p === 'updatemodel') return 'update_model'
  if (p === 'address' || p === 'readmethod') return 'wiring'
  return 'other'
}

interface Change extends RegistryChangeLike {
  subject: string
  origin: string
}

const changes: Change[] = []
// (a) config-card history (oracle dimension), since each subject's collection start.
const cardDir = join(DS, 'oracle-registry', 'config', 'changes')
const subjectSpan: Record<string, { from: number; to: number }> = {}
for (const f of readdirSync(cardDir)) {
  const card = JSON.parse(readFileSync(join(cardDir, f), 'utf8'))
  const rows = card.changes as {
    dimension: string
    key: string
    ts: number
    subject: string
    before: unknown
    after: unknown
  }[]
  subjectSpan[card.subject] = { from: Math.min(...rows.map((r) => r.ts)), to: card.asOf.ts }
  for (const r of rows.filter((x) => x.dimension === 'oracle')) {
    const [, what, ev] = r.key.split('/')
    let kind: RegistryChangeKind = 'other'
    let from: number | string | undefined
    let to: number | string | undefined
    if (what === 'committee') {
      kind = 'quorum'
      from = Array.isArray(r.before) ? r.before.length : undefined
      to = Array.isArray(r.after) ? r.after.length : undefined
    } else if (ev && LOG_KIND[ev.replace(/[^A-Za-z].*$/, '')]) {
      kind = LOG_KIND[ev.replace(/[^A-Za-z].*$/, '')]
    } else if (ev?.startsWith('DiscountRate')) kind = 'discount'
    else if (ev?.startsWith('AssetSource')) kind = 'market_source'
    if (kind === 'discount' && r.after && typeof r.after === 'object') {
      const a = r.after as Record<string, string>
      from = a.oldDiscountRatePerYear
      to = a.newDiscountRatePerYear
    }
    changes.push({ subject: r.subject, origin: 'config-card', kind, entryId: `${r.subject}:${r.key}`, from, to, ts: r.ts })
  }
}
// (b) snapshot parameter diffs (the registry's own detector input), neighbour to neighbour.
{
  const dir = join(DS, 'oracle-registry', 'snapshots')
  const snaps = readdirSync(dir)
    .filter((f) => f !== 'latest.json')
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')))
  for (let i = 1; i < snaps.length; i++) {
    const prev = new Map(snaps[i - 1].entries.map((e: { id: string }) => [e.id, e]))
    for (const e of snaps[i].entries as { id: string; params?: Record<string, unknown>; config?: Record<string, unknown> }[]) {
      const a = prev.get(e.id) as typeof e | undefined
      if (!a) continue
      for (const src of ['params', 'config'] as const)
        for (const k of Object.keys(e[src] ?? {})) {
          const x = a[src]?.[k]
          const y = e[src]?.[k]
          if (x == null || y == null || String(x).toLowerCase() === String(y).toLowerCase()) continue
          // The card history already holds governance-logged changes; keep only diffs it lacks.
          changes.push({
            subject: e.id.split('.')[0],
            origin: 'snapshot-diff',
            kind: classifyParam(k),
            entryId: e.id,
            param: k,
            from: x as string,
            to: y as string,
            ts: snaps[i].ts,
          })
        }
    }
  }
}
// A snapshot diff that repeats a config-card change on the same subject within 60 days is one change.
const dedup = changes.filter(
  (c) =>
    c.origin !== 'snapshot-diff' ||
    !changes.some(
      (o) => o.origin === 'config-card' && o.subject === c.subject && o.kind === c.kind && c.ts - o.ts >= 0 && c.ts - o.ts < 60 * D,
    ),
)

function oracleChangeRates() {
  const perSubject = Object.entries(subjectSpan).map(([subject, span]) => {
    const evs = dedup
      .filter((c) => c.subject === subject)
      .map((c) => fromRegistryChange(c, subject, c.origin))
      .filter((e): e is OracleChangeEvent => e !== null)
      .sort((a, b) => a.ts - b.ts)
    // A position holding the subject, read hourly over the subject's collection span.
    let state = initialEngineState()
    const counts = { watch: 0, warn: 0, critical: 0 }
    const cfg = { ...OFF, oracleChange: DEFAULT_ALERT_CONFIG.oracleChange }
    const ctx = { oracleEvents: evs, oracleEventsCovered: true }
    for (let t = span.from; t <= span.to; t += H) {
      const r = evaluate(
        {
          id: subject,
          ts: t,
          venue: 'any',
          collateral: [{ symbol: subject, amount: 1, oraclePriceUsd: 1, liquidationThreshold: 0.8 }],
          debt: [{ symbol: 'USD', amount: 0.5, priceUsd: 1 }],
        },
        ctx,
        state,
        cfg,
      )
      state = r.state
      for (const a of r.alerts)
        if (isNotifiable(a) && (a.transition === 'fire' || a.transition === 'escalate')) counts[a.severity]++
    }
    const months = (span.to - span.from) / MONTH
    return {
      subject,
      from: iso(span.from),
      to: iso(span.to),
      months: round(months, 1),
      changes: dedup.filter((c) => c.subject === subject).length,
      alertEvents: evs.map((e) => ({ ts: iso(e.ts), kind: e.kind, severity: e.severity, origin: e.source })),
      messages: counts,
      warnPlusPerMonth: round((counts.warn + counts.critical) / months, 3),
    }
  })
  const months = perSubject.reduce((a, s) => a + (s.months ?? 0), 0)
  const warnPlus = perSubject.reduce((a, s) => a + s.messages.warn + s.messages.critical, 0)
  const all = perSubject.reduce((a, s) => a + s.messages.watch + s.messages.warn + s.messages.critical, 0)
  return {
    note: 'Config-card oracle-dimension history (since each subject\'s collection start) plus parameter diffs between the registry snapshots, through fromRegistryChange. Read-access grants (TollGranted) and tightenings are not messages. Bridge, admin and mint dimensions are out of scope for this rule.',
    subjects: perSubject.length,
    subjectMonths: round(months, 1),
    messagesPerSubjectMonth: round(all / months, 3),
    warnPlusPerSubjectMonth: round(warnPlus / months, 3),
    perSubject,
  }
}

// ------------------------------------------------------------------ 3. LST depeg on Chainlink

function stethChainlink() {
  const s = readJson('price-history/steth-eth-1h.json') as {
    startTs: number
    stepSeconds: number
    columns: { oracle: (number | null)[]; oracleLow: (number | null)[] }
  }
  const cfg = { ...OFF, depeg: DEFAULT_ALERT_CONFIG.depeg }
  let state = initialEngineState()
  const msgs: { ts: number; severity: string; bps: number }[] = []
  let first = Number.NaN
  let last = 0
  s.columns.oracle.forEach((ratio, i) => {
    if (ratio === null) return
    const ts = s.startTs + i * s.stepSeconds
    if (Number.isNaN(first)) first = ts
    last = ts
    const r = evaluate(
      {
        id: 'steth',
        ts,
        venue: 'exchange-rate venue',
        collateral: [
          {
            symbol: 'stETH',
            amount: 1,
            oraclePriceUsd: 1,
            marketPriceUsd: ratio,
            liquidationThreshold: 0.83,
            oracleBasis: 'exchangeRate',
            peg: { class: 'lst', underlying: 'ETH', rate: 1 },
          },
        ],
        debt: [{ symbol: 'ETH', amount: 0.5, priceUsd: 1 }],
      },
      { underlyingUsd: { ETH: 1 } },
      state,
      cfg,
    )
    state = r.state
    for (const a of r.alerts)
      if (isNotifiable(a) && (a.transition === 'fire' || a.transition === 'escalate'))
        msgs.push({ ts, severity: a.severity, bps: round(Number(a.value), 0) as number })
  })
  // Stress: May 9 → Jul 31 2022 (Terra, 3AC, Celsius: the stETH discount). Everything else is calm.
  const stressFrom = Date.UTC(2022, 4, 9) / 1000
  const stressTo = Date.UTC(2022, 6, 31) / 1000
  const calm = msgs.filter((m) => m.ts < stressFrom || m.ts > stressTo)
  const calmMonths = (last - first - (stressTo - stressFrom)) / MONTH
  const count = (xs: typeof msgs, sev: string[]) => xs.filter((m) => sev.includes(m.severity)).length
  return {
    source: 'Chainlink STETH/ETH (price-history/steth-eth-1h.json, forward-filled hourly)',
    from: iso(first),
    to: iso(last),
    calmMonths: round(calmMonths, 1),
    calm: {
      messages: calm.length,
      warnPlus: count(calm, ['warn', 'critical']),
      messagesPerMonth: round(calm.length / calmMonths, 3),
      warnPlusPerMonth: round(count(calm, ['warn', 'critical']) / calmMonths, 3),
    },
    stress2022: msgs
      .filter((m) => m.ts >= stressFrom && m.ts <= stressTo)
      .map((m) => ({ ts: iso(m.ts), severity: m.severity, bps: m.bps })),
    calmEpisodes: calm.map((m) => ({ ts: iso(m.ts), severity: m.severity, bps: m.bps })),
  }
}

// ------------------------------------------------------------------ run

function main() {
  const t0 = Date.now()
  const ratioOnly: AlertConfig = { ...OFF, exitCapacity: { ...EXIT, burn: null } }
  const burnSweep: unknown[] = []
  for (const lookbackH of [1, 6, 24])
    for (const warn of [0.3, 0.5, 0.7]) {
      const c = burnCfg(lookbackH, warn)
      const e3 = e3Runs(c)
      const calm = calmRate(c)
      burnSweep.push({
        lookbackH,
        warn,
        e3LeadBeforeFullLockH: e3.map((r) => r.leadBeforeFullLockH.burn),
        e3LeadBeforeShortH: e3.map((r) => r.leadBeforeShortH.burn),
        calmBurnWarnPlusPerMonth: calm.map((r) => r.byKeyPerMonth.burn ?? 0),
        preE3Calm30dBurnWarnPlus: calm.map((r) => r.preE3Calm30d.byKey.burn ?? 0),
      })
    }
  const results = {
    generatedBy: 'scripts/research/position-alert-signal-backtest.ts',
    generatedAt: new Date().toISOString(),
    exitCapacity: {
      venue: 'Aave v3 Core USDC',
      e3: {
        source: 'recall-coverage data/chain/e3/usdc_utilization (virtual underlying balance at every state-changing block), read every 5 minutes',
        exploit: iso(E3_EXPLOIT),
        fullLock: iso(E3_FULL_LOCK),
        fullLockRule: 'first block at or after the exploit with utilization >= 99.9% (the dataset E3_LOCK_UTILIZATION)',
        ratioOnly: e3Runs(ratioOnly),
        withBurnPreset: e3Runs({ ...OFF, exitCapacity: { ...EXIT, burn: CAPACITY_BURN_PRESET } }),
      },
      calm: {
        source: 'venue-stress/history.json aave-core-usdc cash, hourly, outside the stress windows and E3',
        hours: calmHours,
        months: round(calmHours / (MONTH / H), 1),
        segments: calmSegs.length,
        ratioOnly: calmRate(ratioOnly),
        withBurnPreset: calmRate({ ...OFF, exitCapacity: { ...EXIT, burn: CAPACITY_BURN_PRESET } }),
      },
      burnSweep,
      medianCalmCapacityUsd: quantile(calmSegs.flat().map(([, u]) => u), 0.5),
    },
    oracleChange: oracleChangeRates(),
    lstDepegChainlink: stethChainlink(),
  }
  writeFileSync(OUT, JSON.stringify(results, null, 1) + '\n')
  console.log(JSON.stringify(results.exitCapacity.e3, null, 0).slice(0, 3000))
  console.log('calm', JSON.stringify(results.exitCapacity.calm).slice(0, 1500))
  for (const r of burnSweep) console.log('burn', JSON.stringify(r))
  const oc = results.oracleChange
  console.log('oracle', oc.subjects, oc.subjectMonths, oc.messagesPerSubjectMonth, oc.warnPlusPerSubjectMonth)
  for (const s of oc.perSubject) console.log('  ', s.subject, s.months, s.changes, JSON.stringify(s.messages))
  const l = results.lstDepegChainlink
  console.log('steth', l.from, l.to, JSON.stringify(l.calm), 'stress', l.stress2022.length)
  console.log(`wrote ${OUT} in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

main()
