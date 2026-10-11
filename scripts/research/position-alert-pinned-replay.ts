/**
 * position-alert-pinned-replay.ts — replay the position-alert engine over the defining clusters
 * of the Recall Coverage Dataset (spec gate G2: "fires before the breach block for every breached
 * cluster"), on the dataset's own block-pinned health-factor paths.
 *
 *   pnpm tsx scripts/research/position-alert-pinned-replay.ts
 *
 * Inputs: position-alerts/pinned/ in the private datasets repo (board rule N18;
 * $MEMBRANE_DATASETS_DIR, default ../membrane-datasets). They are exported by
 * position-alerts/pinned/exporter/alertPaths.ts, which runs the dataset pipeline's own loaders
 * and path models (membrane-solidity research/recall-dataset at ea00f926):
 *   E1  Morpho USD loops liquidated in EV-1 (3 positions, one oracle path per block)
 *   E3  214 Aave Core pure USD loops through the rsETH lock (HF per tick, 0 breaches)
 *   E4  193 Morpho PT-reUSD positions at t0 (149 loopers in 15 clusters + 44 below $1,000 debt)
 *
 * Breach = the first tick with HF < 1, as the dataset's own breach test. The lib stamps it at
 * the START of that tick's interval (the previous tick), so an alert at the breach tick itself
 * never counts: "before the breach block" is strict.
 *
 * Output: position-alerts/pinned-results.json in the datasets repo (internal: per position, by
 * the pipeline's 12-hex wallet-hash prefix) and docs/research/position-alerts-pinned-results.json
 * (public: per cluster, no position identifier). Deterministic: no network.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gunzipSync } from 'node:zlib'

import { datasetsDir } from '../lib/datasetsDir.mjs'

import {
  DEFAULT_ALERT_CONFIG,
  quantile,
  replay,
  scoreReplay,
  type AlertConfig,
  type PositionSnapshot,
  type ReplayStep,
} from '../../lib/positionAlerts'

const ROOT = process.cwd()
const PINNED = join(datasetsDir(ROOT), 'position-alerts', 'pinned')
const INTERNAL_OUT = join(datasetsDir(ROOT), 'position-alerts', 'pinned-results.json')
const PUBLIC_OUT = join(ROOT, 'docs', 'research', 'position-alerts-pinned-results.json')
const H = 3600
const HORIZON_S = 72 * H
const CADENCES: { label: string; everyS: number }[] = [
  { label: 'every tick', everyS: 0 },
  { label: '1 min', everyS: 60 },
  { label: '5 min', everyS: 300 },
  { label: '1 h', everyS: 3600 },
]

const readJson = (f: string) => {
  const buf = readFileSync(join(PINNED, f))
  return JSON.parse((f.endsWith('.gz') ? gunzipSync(buf) : buf).toString('utf8'))
}
/** Cluster id without the venue's contract address (the cluster's venue is in its asset segments). */
const shortCluster = (c: string | null) =>
  (c ?? 'unclustered').replace(/\/(?:aave-v3|morpho-blue):\d+:0x[0-9a-fA-F]+/, '')
const round = (v: number | null, dp = 4) => (v === null || !Number.isFinite(v) ? null : +v.toFixed(dp))

// ------------------------------------------------------------------ shared scoring

interface Path {
  id: string
  cluster: string
  isLooper: boolean
  /** Monitor ticks: ts and HF, oldest first. */
  ts: number[]
  hf: number[]
  /** Builds the snapshot the monitor reads at tick i. */
  snapshot: (i: number) => PositionSnapshot
  observedLiquidationTs: number | null
}

interface PositionResult {
  id: string
  cluster: string
  isLooper: boolean
  hfFirstRead: number | null
  minHf: number
  breachTs: number | null
  observedLiquidationTs: number | null
  /** By minimum level (warn, critical): lead before the breach, null = missed or no breach. */
  warn: Lead
  critical: Lead
  /** Worsening messages at warn or higher, and those with no breach in the next 72h. */
  warnMessages: number
  warnFalse: number
  criticalMessages: number
  criticalFalse: number
  /** Tier at the first read (0 = none). */
  firstReadLevel: number
}

interface Lead {
  alertedBeforeBreach: boolean | null
  leadS: number | null
  /** Lead from the alert to the first OBSERVED liquidation (the position's own Liquidate log). */
  leadToObservedS: number | null
  censored: boolean
}

function* stepsOf(p: Path): Generator<ReplayStep> {
  for (let i = 0; i < p.ts.length; i++) {
    yield {
      ts: p.ts[i],
      intervalStart: i === 0 ? p.ts[0] : p.ts[i - 1],
      worstHf: p.hf[i],
      snapshot: p.snapshot(i),
    }
  }
}

function runPath(p: Path, config: AlertConfig, everyS: number): PositionResult {
  const r = replay(stepsOf(p), config, { monitorEveryS: everyS })
  const lead = (minLevel: 2 | 3): Lead => {
    const s = scoreReplay(r, { minLevel, horizonS: HORIZON_S })
    if (r.liquidatedAt === null)
      return { alertedBeforeBreach: null, leadS: null, leadToObservedS: null, censored: false }
    const alerted = s.leadS !== null
    return {
      alertedBeforeBreach: alerted,
      leadS: s.leadS,
      leadToObservedS:
        alerted && p.observedLiquidationTs !== null
          ? (s.leadS as number) + (p.observedLiquidationTs - r.liquidatedAt)
          : null,
      censored: s.censored,
    }
  }
  const warnS = scoreReplay(r, { minLevel: 2, horizonS: HORIZON_S })
  const critS = scoreReplay(r, { minLevel: 3, horizonS: HORIZON_S })
  const firstRead = r.alerts.filter((a) => a.ts === r.firstEvalTs)
  return {
    id: p.id,
    cluster: p.cluster,
    isLooper: p.isLooper,
    hfFirstRead: round(p.hf[0], 6),
    minHf: round(Math.min(...p.hf), 6) as number,
    breachTs: r.liquidatedAt,
    observedLiquidationTs: p.observedLiquidationTs,
    warn: lead(2),
    critical: lead(3),
    warnMessages: warnS.worsening,
    warnFalse: warnS.falseAlarms,
    criticalMessages: critS.worsening,
    criticalFalse: critS.falseAlarms,
    firstReadLevel: firstRead.reduce((m, a) => Math.max(m, a.to), 0),
  }
}

interface ClusterSummary {
  cluster: string
  members: number
  breached: number
  /** Breached members with a warn-or-higher (critical) episode open before the breach tick. */
  warnBeforeBreach: number
  criticalBeforeBreach: number
  /** Over breached members alerted at warn+: lead before breach and before the observed liquidation. */
  leadMinS: number | null
  leadMedianS: number | null
  leadToObservedMedianS: number | null
  censored: number
  /** Members that never breached but got a warn+ (critical) message: in-event false alarms. */
  unbreachedWarned: number
  unbreachedCritical: number
  /** Members already at warn+ at the first read. */
  warnAtFirstRead: number
}

function summarise(rows: PositionResult[]): ClusterSummary[] {
  const by = new Map<string, PositionResult[]>()
  for (const r of rows) by.set(r.cluster, [...(by.get(r.cluster) ?? []), r])
  return [...by.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([cluster, rs]) => {
      const br = rs.filter((r) => r.breachTs !== null)
      const leads = br.filter((r) => r.warn.leadS !== null).map((r) => r.warn.leadS as number)
      const obs = br
        .filter((r) => r.warn.leadToObservedS !== null)
        .map((r) => r.warn.leadToObservedS as number)
      const unbr = rs.filter((r) => r.breachTs === null)
      return {
        cluster,
        members: rs.length,
        breached: br.length,
        warnBeforeBreach: br.filter((r) => r.warn.alertedBeforeBreach).length,
        criticalBeforeBreach: br.filter((r) => r.critical.alertedBeforeBreach).length,
        leadMinS: leads.length ? Math.min(...leads) : null,
        leadMedianS: quantile(leads, 0.5),
        leadToObservedMedianS: quantile(obs, 0.5),
        censored: br.filter((r) => r.warn.censored).length,
        unbreachedWarned: unbr.filter((r) => r.warnMessages > 0).length,
        unbreachedCritical: unbr.filter((r) => r.criticalMessages > 0).length,
        warnAtFirstRead: rs.filter((r) => r.firstReadLevel >= 2).length,
      }
    })
}

function gate(clusters: ClusterSummary[]) {
  const breachedClusters = clusters.filter((c) => c.breached > 0)
  return {
    breachedClusters: breachedClusters.length,
    clustersAllWarnedBeforeBreach: breachedClusters.filter((c) => c.warnBeforeBreach === c.breached)
      .length,
    breachedPositions: clusters.reduce((a, c) => a + c.breached, 0),
    warnedBeforeBreach: clusters.reduce((a, c) => a + c.warnBeforeBreach, 0),
    criticalBeforeBreach: clusters.reduce((a, c) => a + c.criticalBeforeBreach, 0),
    met: breachedClusters.every((c) => c.warnBeforeBreach === c.breached),
  }
}

function runEvent(paths: Path[], config: AlertConfig, cadences = CADENCES) {
  const byCadence = cadences.map(({ label, everyS }) => {
    const rows = paths.map((p) => runPath(p, config, everyS))
    const clusters = summarise(rows)
    return { cadence: label, everyS, gate: gate(clusters), clusters, rows }
  })
  return byCadence
}

// ------------------------------------------------------------------ E1 Morpho USD loops

const e1 = readJson('e1-morpho-paths.json')
const e1Paths: Path[] = []
const e1Unreplayable: { cluster: string; reason: string }[] = []
for (const p of e1.positions) {
  const o = p.oracle ? e1.oracles[p.oracle] : null
  if (!o || !p.collateralUnits || !p.debtUsd) {
    e1Unreplayable.push({ cluster: shortCluster(p.cluster), reason: 'no oracle path in the pull (chain ' + p.chainId + ')' })
    continue
  }
  const hf = (o.px as number[]).map((px) => (p.collateralUnits * px * p.lltv) / p.debtUsd)
  e1Paths.push({
    id: p.id,
    cluster: shortCluster(p.cluster),
    isLooper: p.isLooper,
    ts: o.ts,
    hf,
    snapshot: (i) => ({
      id: p.id,
      ts: o.ts[i],
      venue: `Morpho ${p.collateral}/${p.debtAsset}`,
      collateral: [
        {
          symbol: p.collateral,
          amount: p.collateralUnits,
          oraclePriceUsd: o.px[i],
          liquidationThreshold: p.lltv,
        },
      ],
      debt: [{ symbol: p.debtAsset, amount: p.debtUsd, priceUsd: 1 }],
    }),
    observedLiquidationTs: p.liquidations.length ? p.liquidations[0].ts : null,
  })
}

// ------------------------------------------------------------------ E3 Aave Core USD loops

const e3 = readJson('e3-loop-paths.json.gz')
const e3Paths: Path[] = e3.positions.map(
  (p: {
    id: string
    cluster: string
    lt: number
    debtUsd: number
    hf: number[]
  }): Path => ({
    id: p.id,
    cluster: shortCluster(p.cluster),
    isLooper: true,
    ts: e3.ticks.ts,
    hf: p.hf,
    // The basket's HF is what the monitor reads; one USD-priced leg reproduces it exactly.
    snapshot: (i) => ({
      id: p.id,
      ts: e3.ticks.ts[i],
      venue: 'Aave V3 Core',
      collateral: [
        {
          symbol: 'USD-loop basket',
          amount: (p.hf[i] * p.debtUsd) / p.lt,
          oraclePriceUsd: 1,
          liquidationThreshold: p.lt,
        },
      ],
      debt: [{ symbol: 'USD debt', amount: p.debtUsd, priceUsd: 1 }],
    }),
    observedLiquidationTs: null,
  }),
)

// ------------------------------------------------------------------ E4 PT-reUSD loopers

const e4 = readJson('e4-looper-paths.json')
const e4Ts: number[] = [...e4.preT0.ts, ...e4.ticks.ts]
const e4Px: number[] = [...e4.preT0.px, ...e4.ticks.px]
const e4Factor = (m: 'usdc' | 'usdt'): number[] => [
  ...e4.preT0.ts.map(() => 1),
  ...e4.factor[m],
]
const e4F = { usdc: e4Factor('usdc'), usdt: e4Factor('usdt') }
const e4Paths: Path[] = e4.positions.map(
  (p: {
    id: string
    cluster: string
    isLooper: boolean
    market: 'usdc' | 'usdt'
    lltv: number
    units: number
    debtUsd: number
    liquidations: { ts: number }[]
  }): Path => {
    const f = e4F[p.market]
    const hf = e4Px.map((px, i) => (p.units * px * p.lltv) / (p.debtUsd * f[i]))
    return {
      id: p.id,
      cluster: shortCluster(p.cluster),
      isLooper: p.isLooper,
      ts: e4Ts,
      hf,
      snapshot: (i) => ({
        id: p.id,
        ts: e4Ts[i],
        venue: `Morpho PT-reUSD-10DEC2026/${p.market.toUpperCase()}`,
        collateral: [
          {
            symbol: 'PT-reUSD-10DEC2026',
            amount: p.units,
            oraclePriceUsd: e4Px[i],
            liquidationThreshold: p.lltv,
          },
        ],
        debt: [{ symbol: p.market.toUpperCase(), amount: p.debtUsd * f[i], priceUsd: 1 }],
      }),
      observedLiquidationTs: p.liquidations.length ? p.liquidations[0].ts : null,
    }
  },
)

// ------------------------------------------------------------------ warn-line sweep (loops)

/** Default config with the health-factor warn line at L (critical halfway to 1.00, watch L + 0.10). */
function hfLineConfig(L: number): AlertConfig {
  const base = DEFAULT_ALERT_CONFIG.healthFactor!
  return {
    ...DEFAULT_ALERT_CONFIG,
    healthFactor: {
      ...base,
      enter: { watch: +(L + 0.1).toFixed(4), warn: L, critical: +(1 + (L - 1) / 2).toFixed(4) },
      band: Math.min(base.band, +((L - 1) / 2).toFixed(4)),
    },
  }
}

const SWEEP: { label: string; config: AlertConfig }[] = [
  ...[1.005, 1.01, 1.02, 1.03, 1.05, 1.1, 1.15].map((L) => ({
    label: `HF warn < ${L}`,
    config: hfLineConfig(L),
  })),
  { label: 'cushion burn only (HF tiers off)', config: { ...DEFAULT_ALERT_CONFIG, healthFactor: null } },
]

function sweepRow(label: string, config: AlertConfig) {
  const tick = [{ label: 'every tick', everyS: 0 }]
  const [r1] = runEvent(e1Paths, config, tick)
  const [r3] = runEvent(e3Paths, config, tick)
  const [r4] = runEvent(e4Paths, config, tick)
  const breached = (r: typeof r4) => r.rows.filter((x) => x.breachTs !== null)
  const leads = breached(r4)
    .filter((x) => x.warn.leadS !== null)
    .map((x) => x.warn.leadS as number)
  const e4Unbreached = r4.rows.filter((x) => x.breachTs === null)
  const e3Months = (e3.endTs - e3.startTs) / (30 * 86400)
  return {
    label,
    e1: { breached: r1.gate.breachedPositions, warnedBeforeBreach: r1.gate.warnedBeforeBreach },
    e4: {
      breached: r4.gate.breachedPositions,
      warnedBeforeBreach: r4.gate.warnedBeforeBreach,
      warnedAtFirstRead: breached(r4).filter((x) => x.firstReadLevel >= 2).length,
      leadMedianS: quantile(leads, 0.5),
      leadMinS: leads.length ? Math.min(...leads) : null,
      unbreached: e4Unbreached.length,
      unbreachedWarned: e4Unbreached.filter((x) => x.warnMessages > 0).length,
    },
    e3: {
      loops: r3.rows.length,
      warned: r3.rows.filter((x) => x.warnMessages > 0).length,
      warnedAtFirstRead: r3.rows.filter((x) => x.firstReadLevel >= 2).length,
      warnPerPositionMonth: round(
        r3.rows.reduce((a, x) => a + x.warnMessages, 0) / (r3.rows.length * e3Months),
        3,
      ),
    },
    gateMet: r1.gate.met && r3.gate.met && r4.gate.met,
  }
}

// ------------------------------------------------------------------ run + write

function main() {
  const t0 = Date.now()
  const config = DEFAULT_ALERT_CONFIG
  const events = {
    E1: {
      source: 'recall-coverage EV-1 Morpho rows (inputs/oct10 morpho_liquidations.csv + data/chain/e1); oracle price() per block',
      window: { fromTs: e1Paths[0]?.ts[0] ?? null, toTs: e1Paths[0]?.ts.at(-1) ?? null },
      unreplayable: e1Unreplayable,
      runs: runEvent(e1Paths, config),
    },
    E3: {
      source: 'recall-coverage EV-3 positions_start + reserve_state + underlying_prices; HF per tick by the dataset formula (e3.ts:398-407)',
      window: { fromTs: e3.startTs, toTs: e3.endTs, ticks: e3.ticks.ts.length },
      datasetMinHf: e3.minHf,
      observedLiquidationsOfLoopers: e3.observedLiquidationsOfLoopers,
      // E3 ticks are about an hour apart, so a finer monitor sees nothing new.
      runs: runEvent(e3Paths, config, CADENCES.slice(0, 1)),
    },
    E4: {
      source: 'recall-coverage EV-4 positions_t0 + oracle (price() per block t0-300..t0+600, every 5th to t0+2h, hourly to t0+24h) + market borrow rate accrual',
      window: { fromTs: e4Ts[0], toTs: e4Ts.at(-1), t0: e4.t0 },
      runs: runEvent(e4Paths, config),
    },
  }
  const e3Run = events.E3.runs[0]
  const months = (e3.endTs - e3.startTs) / (30 * 86400)
  const e3Summary = {
    loops: e3Paths.length,
    windowDays: round((e3.endTs - e3.startTs) / 86400, 2),
    breaches: e3Run.gate.breachedPositions,
    warnAtFirstRead: e3Run.rows.filter((r) => r.firstReadLevel >= 2).length,
    criticalAtFirstRead: e3Run.rows.filter((r) => r.firstReadLevel >= 3).length,
    warnedAnyTime: e3Run.rows.filter((r) => r.warnMessages > 0).length,
    criticalAnyTime: e3Run.rows.filter((r) => r.criticalMessages > 0).length,
    warnMessages: e3Run.rows.reduce((a, r) => a + r.warnMessages, 0),
    criticalMessages: e3Run.rows.reduce((a, r) => a + r.criticalMessages, 0),
    warnPerPositionMonth: round(e3Run.rows.reduce((a, r) => a + r.warnMessages, 0) / (e3Paths.length * months), 3),
    criticalPerPositionMonth: round(
      e3Run.rows.reduce((a, r) => a + r.criticalMessages, 0) / (e3Paths.length * months),
      3,
    ),
    note: 'No loop breached, so every warn+ message is a false alarm by definition (no liquidation within 72h).',
  }
  const loopSweep = SWEEP.map(({ label, config: c }) => sweepRow(label, c))
  const results = {
    generatedBy: 'scripts/research/position-alert-pinned-replay.ts',
    generatedAt: new Date().toISOString(),
    config: 'DEFAULT_ALERT_CONFIG',
    definitions:
      'breach = first tick with HF < 1 on the dataset path, stamped at the previous tick (strict). Lead = breach − start of the earliest warn+ (critical) episode still open. censored = that episode opened at the first read. False alarm = worsening message with no breach in 72h.',
    events,
    e3Summary,
    loopSweep,
  }
  writeFileSync(INTERNAL_OUT, JSON.stringify(results, null, 1) + '\n')
  console.log(`wrote ${INTERNAL_OUT} (internal, per position)`)
  writeFileSync(PUBLIC_OUT, JSON.stringify(publicCopy(results), null, 1) + '\n')
  console.log(`wrote ${PUBLIC_OUT} (public, per cluster)`)
  for (const [k, ev] of Object.entries(events))
    for (const r of ev.runs)
      console.log(k, r.cadence.padEnd(10), JSON.stringify(r.gate))
  console.log('E3', JSON.stringify(e3Summary))
  for (const row of loopSweep) console.log('sweep', JSON.stringify(row))
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

/** Per-cluster tables only: the per-position rows stay in the datasets repo (spec G2, board N18). */
function publicCopy(results: { events: Record<string, { runs: { rows?: unknown }[] }> }) {
  const copy = JSON.parse(JSON.stringify(results))
  for (const ev of Object.values(copy.events) as { runs: { rows?: unknown }[] }[])
    for (const r of ev.runs) delete r.rows
  const text = JSON.stringify(copy)
  if (/"id":/.test(text) || /0x[0-9a-fA-F]{40}/.test(text))
    throw new Error('public pinned results still hold a position identifier')
  return copy
}

main()
