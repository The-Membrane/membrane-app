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
  CORRELATED_LOOP_HF,
  DEFAULT_ALERT_CONFIG,
  detectPriceFreeze,
  quantile,
  replay,
  scoreReplay,
  type AlertConfig,
  type MarketContext,
  type OracleChangeEvent,
  type PositionSnapshot,
  type ReplayStep,
} from '../../lib/positionAlerts'

const ROOT = process.cwd()
const PINNED = join(datasetsDir(ROOT), 'position-alerts', 'pinned')
const E2_FILE = join(datasetsDir(ROOT), 'position-alerts', 'e2-stream-nov-2025.json')
const DS = datasetsDir(ROOT)
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
const round = (v: number | null, dp = 4) =>
  v === null || !Number.isFinite(v) ? null : +v.toFixed(dp)

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
  ctx?: (i: number) => MarketContext
  observedLiquidationTs: number | null
  /** Score against this breach time instead of the first tick with HF < 1. */
  knownBreachTs?: number
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
  /** Rule whose episode gave the lead. */
  leadRule: string | null
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
      ctx: p.ctx?.(i),
    }
  }
}

function runPath(p: Path, config: AlertConfig, everyS: number): PositionResult {
  const r = replay(stepsOf(p), config, {
    monitorEveryS: everyS,
    knownLiquidationTs: p.knownBreachTs ?? null,
  })
  const lead = (minLevel: 2 | 3): Lead => {
    const s = scoreReplay(r, { minLevel, horizonS: HORIZON_S })
    if (r.liquidatedAt === null)
      return {
        alertedBeforeBreach: null,
        leadS: null,
        leadRule: null,
        leadToObservedS: null,
        censored: false,
      }
    const alerted = s.leadS !== null
    return {
      alertedBeforeBreach: alerted,
      leadS: s.leadS,
      leadRule: s.leadRule,
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
    // A path already under HF 1 at its first read has no "before": a reconstruction that does
    // not hold for that account (E1 census). Gate again without those.
    const scoreable = rows.filter((r) => r.hfFirstRead === null || r.hfFirstRead >= 1)
    return {
      cadence: label,
      everyS,
      gate: gate(clusters),
      gateScoreable: {
        ...gate(summarise(scoreable)),
        startBelowOne: rows.length - scoreable.length,
      },
      clusters,
      rows,
    }
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
    e1Unreplayable.push({
      cluster: shortCluster(p.cluster),
      reason: 'no oracle path in the pull (chain ' + p.chainId + ')',
    })
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
  (p: { id: string; cluster: string; lt: number; debtUsd: number; hf: number[] }): Path => ({
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
const e4Factor = (m: 'usdc' | 'usdt'): number[] => [...e4.preT0.ts.map(() => 1), ...e4.factor[m]]
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

// ------------------------------------------------------------------ E1 Aave census (pinned Chainlink rounds)

/**
 * Every account the Oct-10 census includes (1,751, oct10-2025/evidence.json), priced minute
 * by minute on the Chainlink rounds of the spec's E1 pull (recall-coverage
 * data/chain/e1/chainlink_rounds, mainnet feeds, seeded at Oct 9 23:59). OP and ARB have no
 * mainnet round: Binance 1m spot stands in. Each series is scaled so it prints the account's
 * own state price at the liquidation minute (pStateColl / pStateDebt), so the path ends at the
 * census's rebased breach. Breach = the first minute with HF < 1 on that path (at the latest
 * the liquidation minute); the real liquidation time is kept as the observed one.
 */
interface CensusRow {
  user: string
  chain: string
  t0Index: number
  t0Ts: number
  pStateColl: number | null
  pStateDebt: number | null
  collateralUsd: number
  debtUsd: number
  liqLine: number
  collSymbol: string
  debtSymbol: string
  excluded: boolean
}
const E1_START = Date.UTC(2025, 9, 10) / 1000
const E1_MINUTES = 2880
const rounds = (
  readFileSync(join(DS, 'recall-coverage/data/chain/e1/chainlink_rounds.jsonl'), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((l) => JSON.parse(l)) as { feed: string; answer: number; updated_at: number }[]
).sort((a, b) => a.updated_at - b.updated_at)
/** Feed answer in force at the end of each minute from Oct 10 00:00 UTC. */
function minuteGrid(feed: string): (number | null)[] {
  const rs = rounds.filter((r) => r.feed === feed)
  const out: (number | null)[] = []
  let j = -1
  for (let i = 0; i < E1_MINUTES; i++) {
    const t = E1_START + i * 60 + 59
    while (j + 1 < rs.length && rs[j + 1].updated_at <= t) j++
    out.push(j >= 0 ? rs[j].answer : null)
  }
  return out
}
const opArb = JSON.parse(readFileSync(join(DS, 'position-alerts/e1-op-arb-1m.json'), 'utf8'))
const grid: Record<string, (number | null)[]> = {}
const feedGrid = (feed: string) => (grid[feed] ??= minuteGrid(feed))
const E1_STABLES = new Set([
  'USDC',
  'USDT',
  'USD₮0',
  'USDbC',
  'DAI',
  'GHO',
  'LUSD',
  'sUSD',
  'PYUSD',
])
const ETH_LIKE = new Set(['WETH', 'wstETH', 'rETH', 'weETH', 'cbETH', 'tETH', 'ETHx', 'osETH'])
const BTC_LIKE = new Set(['WBTC', 'cbBTC', 'tBTC', 'LBTC'])
const OWN_FEED: Record<string, string> = {
  LINK: 'LINK / USD',
  AAVE: 'AAVE / USD',
  UNI: 'UNI / USD',
  CRV: 'CRV / USD',
  ENS: 'ENS / USD',
  '1INCH': '1INCH / USD',
  BAL: 'BAL / USD',
  MKR: 'MKR / USD',
  USDe: 'USDe / USD',
  sUSDe: 'USDe / USD',
}
/** Unscaled minute series for an asset (null = no source), and where it came from. */
function rawSeries(sym: string): { px: (number | null)[]; source: string } | null {
  if (E1_STABLES.has(sym)) return { px: Array(E1_MINUTES).fill(1), source: '$1' }
  if (ETH_LIKE.has(sym)) return { px: feedGrid('ETH / USD'), source: 'Chainlink ETH / USD' }
  if (BTC_LIKE.has(sym)) return { px: feedGrid('BTC / USD'), source: 'Chainlink BTC / USD' }
  if (OWN_FEED[sym]) return { px: feedGrid(OWN_FEED[sym]), source: `Chainlink ${OWN_FEED[sym]}` }
  if (sym === 'LDO') {
    const l = feedGrid('LDO / ETH')
    const e = feedGrid('ETH / USD')
    return {
      px: l.map((v, i) => (v === null || e[i] === null ? null : v * (e[i] as number))),
      source: 'Chainlink LDO / ETH × ETH / USD',
    }
  }
  if (sym === 'OP')
    return { px: opArb.columns.opClose, source: 'Binance OPUSDT 1m (L2 feed proxy)' }
  if (sym === 'ARB')
    return { px: opArb.columns.arbClose, source: 'Binance ARBUSDT 1m (L2 feed proxy)' }
  return null
}
const censusCluster = (sym: string) =>
  E1_STABLES.has(sym)
    ? `EV-1/aave/stable_other/${sym}`
    : sym === 'sUSDe' || sym === 'USDe'
      ? `EV-1/aave/${sym}`
      : `EV-1/aave/cross_asset/${sym}`

const census = JSON.parse(readFileSync(join(DS, 'oct10-2025/evidence.json'), 'utf8'))
  .cohort as CensusRow[]
const e1CensusSkipped: Record<string, number> = {}
const e1CensusSources: Record<string, string> = {}
const e1CensusPaths: Path[] = []
for (const r of census) {
  if (r.excluded) {
    e1CensusSkipped['census-excluded (no rebased breach)'] =
      (e1CensusSkipped['census-excluded (no rebased breach)'] ?? 0) + 1
    continue
  }
  const c = rawSeries(r.collSymbol)
  const d = rawSeries(r.debtSymbol)
  if (!c || !d || !(r.debtUsd > 0) || !(r.collateralUsd > 0)) {
    const why = !c
      ? `no price source for ${r.collSymbol}`
      : !d
        ? `no price source for ${r.debtSymbol}`
        : 'no debt'
    e1CensusSkipped[why] = (e1CensusSkipped[why] ?? 0) + 1
    continue
  }
  e1CensusSources[r.collSymbol] = c.source
  e1CensusSources[r.debtSymbol] = d.source
  const i0 = Math.min(r.t0Index, E1_MINUTES - 1)
  const c0 = c.px[i0]
  const d0 = d.px[i0]
  if (!c0 || !d0) {
    e1CensusSkipped['no price at the liquidation minute'] =
      (e1CensusSkipped['no price at the liquidation minute'] ?? 0) + 1
    continue
  }
  // Census rows with no collateral series (priced: false) carry the block N-1 snapshot unrebased:
  // anchor them on the feed's own print at the liquidation minute.
  const sc = r.pStateColl ?? c0
  const sd = r.pStateDebt ?? d0
  const kc = sc / c0
  const kd = sd / d0
  const collAmount = r.collateralUsd / sc
  const debtAmount = r.debtUsd / sd
  const ts: number[] = []
  const hf: number[] = []
  const pc: number[] = []
  const pd: number[] = []
  // Through the liquidation minute itself, where the path prints the census state (HF < 1).
  for (let i = 0; i <= i0; i++) {
    const a = c.px[i]
    const b = d.px[i]
    if (a === null || b === null) continue
    ts.push(E1_START + i * 60)
    pc.push(a * kc)
    pd.push(b * kd)
    hf.push((collAmount * a * kc * r.liqLine) / (debtAmount * b * kd))
  }
  if (!ts.length) {
    e1CensusSkipped['liquidated in the first minute'] =
      (e1CensusSkipped['liquidated in the first minute'] ?? 0) + 1
    continue
  }
  e1CensusPaths.push({
    id: r.user.slice(2, 14),
    cluster: censusCluster(r.collSymbol),
    isLooper: false,
    ts,
    hf,
    snapshot: (i) => ({
      id: r.user,
      ts: ts[i],
      venue: `Aave V3 ${r.chain}`,
      collateral: [
        {
          symbol: r.collSymbol,
          amount: collAmount,
          oraclePriceUsd: pc[i],
          liquidationThreshold: r.liqLine,
        },
      ],
      debt: [{ symbol: r.debtSymbol, amount: debtAmount, priceUsd: pd[i] }],
    }),
    observedLiquidationTs: r.t0Ts,
  })
}

// ------------------------------------------------------------------ E2 Stream xUSD / Elixir deUSD (own pull)

interface E2Point {
  ts: number
  collateral: number | null
  collateralValue: number | null
  collateralUsd: number | null
  borrow: number | null
  borrowUsd: number | null
}

const e2 = JSON.parse(readFileSync(E2_FILE, 'utf8'))
const E2_MIN_DEBT = 1_000
const e2Market = new Map<
  string,
  { collateral: string; loan: string; lltv: number; chainId: number }
>(
  e2.markets.map(
    (m: { chainId: number; marketId: string; collateral: string; loan: string; lltv: number }) => [
      `${m.chainId}:${m.marketId}`,
      m,
    ],
  ),
)
/** Market price at ts (last point at or before), by collateral symbol. */
const e2PriceSeries: Record<string, [number, number][]> = Object.fromEntries(
  Object.entries(e2.marketPrices as Record<string, { series: [number, number][] }>).map(
    ([k, v]) => [k, v.series],
  ),
)
function priceAt(series: [number, number][] | undefined, ts: number): number | null {
  if (!series?.length || ts < series[0][0]) return null
  let lo = 0
  let hi = series.length - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (series[mid][0] <= ts) lo = mid
    else hi = mid - 1
  }
  return ts - series[lo][0] <= 3 * H ? series[lo][1] : null
}

interface E2Prepared {
  id: string
  cluster: string
  collateral: string
  lltv: number
  hardcoded: boolean
  points: E2Point[]
  marketPx: (number | null)[]
  oracleEvents: OracleChangeEvent[]
  liquidationTs: number | null
}

const e2Prepared: E2Prepared[] = []
const e2OpenedLate: { collateral: string; openedTs: number }[] = []
let e2Dust = 0
for (const p of e2.positions as {
  chainId: number
  marketId: string
  user: string
  history: E2Point[]
}[]) {
  const m = e2Market.get(`${p.chainId}:${p.marketId}`)!
  const pts = p.history.filter(
    (x) => (x.borrow ?? 0) > 0 && (x.collateral ?? 0) > 0 && x.collateralValue !== null,
  )
  const inWin = pts.filter((x) => x.ts >= e2.specWindow.fromTs && x.ts <= e2.specWindow.toTs)
  if (!inWin.length || Math.max(...inWin.map((x) => x.borrow ?? 0)) < E2_MIN_DEBT) {
    e2Dust++
    continue
  }
  // The cohort is the positions open at the window start (as E3 positions_start and E4
  // positions_t0). A position opened mid-collapse against a fixed oracle is not a victim.
  if (pts[0].ts > e2.specWindow.fromTs) {
    e2OpenedLate.push({ collateral: m.collateral, openedTs: pts[0].ts })
    continue
  }
  const sym = m.collateral.startsWith('PT-') ? null : m.collateral
  const series = sym ? e2PriceSeries[sym] : undefined
  const fallback = sym === 'sdeUSD' ? e2PriceSeries['sdeUSD (DefiLlama on-chain)'] : undefined
  const oraclePx = pts.map((x) => (x.collateralValue as number) / (x.collateral as number))
  const hardcoded = Math.max(...oraclePx) - Math.min(...oraclePx) < 1e-9
  // CoinGecko trades first; DefiLlama's on-chain sdeUSD price fills its gaps.
  const marketPx = pts.map((x) => priceAt(series, x.ts) ?? priceAt(fallback, x.ts))
  const liq = (e2.liquidations as { user: string; marketId: string; chainId: number; ts: number }[])
    .filter((l) => l.user === p.user && l.marketId === p.marketId && l.chainId === p.chainId)
    .map((l) => l.ts)
    .sort((a, b) => a - b)
  e2Prepared.push({
    id: `${p.user.slice(2, 14)}`,
    cluster: `EV-2/morpho/${m.collateral}/${m.loan}/chain-${m.chainId}/lltv-${m.lltv}`,
    collateral: m.collateral,
    lltv: m.lltv,
    hardcoded,
    points: pts,
    marketPx,
    // A hard-coded oracle never moves, so "frozen" says nothing new: the depeg rule covers it.
    oracleEvents: hardcoded
      ? []
      : detectPriceFreeze(
          pts.map((x, i) => ({ ts: x.ts, oraclePx: oraclePx[i], marketPx: marketPx[i] })),
          m.collateral,
          `${p.chainId}:${p.marketId}`,
        ),
    liquidationTs: liq[0] ?? null,
  })
}
// Dataset rule: clusters under 3 members merge into (protocol, collateral, other).
{
  const n = new Map<string, number>()
  for (const x of e2Prepared) n.set(x.cluster, (n.get(x.cluster) ?? 0) + 1)
  for (const x of e2Prepared)
    if ((n.get(x.cluster) ?? 0) < 3) x.cluster = `EV-2/morpho/${x.collateral}/other`
}

/** basis 'oracle': breach at oracle HF < 1 (the venue's line); 'market': at market HF < 1. */
function e2Paths(basis: 'oracle' | 'market'): Path[] {
  return e2Prepared
    .map((x): Path | null => {
      const idx = x.points
        .map((_, i) => i)
        .filter((i) => basis === 'oracle' || x.marketPx[i] !== null)
      if (!idx.length) return null
      const pt = (i: number) => x.points[idx[i]]
      const oracle = (i: number) => (pt(i).collateralValue as number) / (pt(i).collateral as number)
      const market = (i: number) => x.marketPx[idx[i]]
      const hf = idx.map((_, i) => {
        const px = basis === 'oracle' ? oracle(i) : (market(i) as number)
        return ((pt(i).collateral as number) * px * x.lltv) / (pt(i).borrow as number)
      })
      return {
        id: x.id,
        cluster: x.cluster,
        isLooper: true,
        ts: idx.map((_, i) => pt(i).ts),
        hf,
        snapshot: (i) => ({
          id: x.id,
          ts: pt(i).ts,
          venue: `Morpho ${x.collateral}`,
          collateral: [
            {
              symbol: x.collateral,
              amount: pt(i).collateral as number,
              oraclePriceUsd: oracle(i),
              marketPriceUsd: market(i) ?? undefined,
              liquidationThreshold: x.lltv,
              oracleBasis: x.hardcoded ? 'hardcoded' : 'exchangeRate',
              // Peg = the venue's own price (NAV for xUSD / sdeUSD, $1 for deUSD).
              peg:
                market(i) === null || x.collateral.startsWith('PT-')
                  ? undefined
                  : { class: 'stable', underlying: 'USD', rate: oracle(i) },
            },
          ],
          debt: [{ symbol: 'USDC', amount: pt(i).borrow as number, priceUsd: 1 }],
        }),
        ctx: () => ({ oracleEvents: x.oracleEvents, oracleEventsCovered: true }),
        observedLiquidationTs: x.liquidationTs,
      }
    })
    .filter((p): p is Path => p !== null)
}

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
  {
    label: 'cushion burn only (HF tiers off)',
    config: { ...DEFAULT_ALERT_CONFIG, healthFactor: null },
  },
  {
    label: 'CORRELATED_LOOP_HF (1.05 / 1.02 / 1.01)',
    config: { ...DEFAULT_ALERT_CONFIG, healthFactor: CORRELATED_LOOP_HF },
  },
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
    E1census: {
      source:
        'oct10-2025/evidence.json included census accounts, priced on recall-coverage data/chain/e1/chainlink_rounds (mainnet feeds) and Binance 1m for OP / ARB, each scaled to the account state price at its liquidation minute; breach = first minute with HF < 1 on the path (at the latest the liquidation minute)',
      window: { fromTs: E1_START, toTs: E1_START + E1_MINUTES * 60 },
      replayed: e1CensusPaths.length,
      skipped: e1CensusSkipped,
      priceSources: e1CensusSources,
      runs: runEvent(e1CensusPaths, config, [
        { label: '1 min', everyS: 0 },
        { label: '5 min', everyS: 300 },
        { label: '15 min', everyS: 900 },
      ]),
    },
    E1: {
      source:
        'recall-coverage EV-1 Morpho rows (inputs/oct10 morpho_liquidations.csv + data/chain/e1); oracle price() per block',
      window: { fromTs: e1Paths[0]?.ts[0] ?? null, toTs: e1Paths[0]?.ts.at(-1) ?? null },
      unreplayable: e1Unreplayable,
      runs: runEvent(e1Paths, config),
    },
    E3: {
      source:
        'recall-coverage EV-3 positions_start + reserve_state + underlying_prices; HF per tick by the dataset formula (e3.ts:398-407)',
      window: { fromTs: e3.startTs, toTs: e3.endTs, ticks: e3.ticks.ts.length },
      datasetMinHf: e3.minHf,
      observedLiquidationsOfLoopers: e3.observedLiquidationsOfLoopers,
      // E3 ticks are about an hour apart, so a finer monitor sees nothing new.
      runs: runEvent(e3Paths, config, CADENCES.slice(0, 1)),
    },
    E2: {
      source:
        'own pull (not a pinned table): Morpho API hourly position history on every xUSD / deUSD / sdeUSD market, DefiLlama CoinGecko prices',
      window: e2.specWindow,
      history: e2.historyWindow,
      positionsReplayed: e2Prepared.length,
      dustPositionsSkipped: e2Dust,
      openedAfterWindowStart: e2OpenedLate.map((x) => ({ ...x, debtUsdMax: undefined })),
      uncovered: e2.uncovered,
      liquidationsSinceHistoryStart: e2.liquidations.length,
      priceFreezeEvents: e2Prepared.map((x) => ({
        cluster: x.cluster,
        events: x.oracleEvents.map((e) => e.ts),
      })),
      oracleBasis: {
        runs: runEvent(e2Paths('oracle'), config, [{ label: '1 h', everyS: 0 }]),
      },
      marketBasis: {
        runs: runEvent(e2Paths('market'), config, [{ label: '1 h', everyS: 0 }]),
      },
      runs: [] as ReturnType<typeof runEvent>,
    },
    E4: {
      source:
        'recall-coverage EV-4 positions_t0 + oracle (price() per block t0-300..t0+600, every 5th to t0+2h, hourly to t0+24h) + market borrow rate accrual',
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
    warnPerPositionMonth: round(
      e3Run.rows.reduce((a, r) => a + r.warnMessages, 0) / (e3Paths.length * months),
      3,
    ),
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
    for (const r of ev.runs) console.log(k, r.cadence.padEnd(10), JSON.stringify(r.gate))
  for (const b of ['oracleBasis', 'marketBasis'] as const)
    for (const r of events.E2[b].runs) {
      console.log('E2', b, JSON.stringify(r.gate))
      for (const x of r.rows)
        console.log(
          '  ',
          x.cluster.padEnd(34),
          'HF0',
          x.hfFirstRead,
          'breach',
          x.breachTs && new Date(x.breachTs * 1000).toISOString().slice(5, 16),
          'warn',
          x.warn.leadS,
          x.warn.leadRule,
          'crit',
          x.critical.leadS,
          x.critical.leadRule,
        )
    }
  console.log('E3', JSON.stringify(e3Summary))
  for (const row of loopSweep) console.log('sweep', JSON.stringify(row))
  console.log(`done in ${((Date.now() - t0) / 1000).toFixed(1)}s`)
}

/** Per-cluster tables only: the per-position rows stay in the datasets repo (spec G2, board N18). */
function publicCopy(results: { events: Record<string, { runs: { rows?: unknown }[] }> }) {
  const copy = JSON.parse(JSON.stringify(results))
  for (const ev of Object.values(copy.events) as Record<
    string,
    { runs?: { rows?: unknown }[] }
  >[]) {
    for (const r of (ev as { runs: { rows?: unknown }[] }).runs) delete r.rows
    for (const sub of [ev.oracleBasis, ev.marketBasis])
      for (const r of sub?.runs ?? []) delete r.rows
  }
  const text = JSON.stringify(copy)
  if (/"id":/.test(text) || /0x[0-9a-fA-F]{40}/.test(text))
    throw new Error('public pinned results still hold a position identifier')
  return copy
}

main()
