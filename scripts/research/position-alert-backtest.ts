/**
 * position-alert-backtest.ts — replay historical price paths through the position-alert
 * engine and score what a set-and-forget borrower would have received.
 *
 *   pnpm tsx scripts/research/position-alert-backtest.ts [--skip-sweeps]
 *
 * Inputs live in the private datasets repo (board rule N18): $MEMBRANE_DATASETS_DIR, default
 * ../membrane-datasets. All measured; position-alerts/manifest.json pins each file's SHA-256.
 *   E1  oct10-2025/                        Oct 10 2025: Chainlink 1m + 2,350 real Aave liquidations
 *   E2  position-alerts/e2-nov-2025        Nov 2025: Binance 1m + 146 real Morpho liquidated positions + deUSD
 *   E3  position-alerts/e3-apr-2026        Apr 2026 Kelp: rsETH/ETH, Binance 1m, Aave USDe cash
 *   E4  position-alerts/e4-aug-2026        Aug 25 2026: PT-reUSD oracle + 20 real Morpho liquidated positions
 *   H   position-alerts/hourly-eth-btc     ETH/BTC hourly 2020-01 → 2026-10 (synthetic positions)
 *   D   position-alerts/depeg-history      stETH/ETH, USDC, USDe hourly (depeg rule calm rate)
 *
 * Output: position-alerts/backtest-results.json in the datasets repo (internal), and the same
 * tables with no wallet identifier in docs/research/position-alerts-backtest-results.json (the
 * public copy the memo quotes). Deterministic: no randomness, no network.
 *
 * Definitions of lead time, missed, censored and false alarm are in
 * lib/positionAlerts/backtest.ts and are not restated here.
 */

import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import { datasetsDir } from '../lib/datasetsDir.mjs'

import {
  DEFAULT_ALERT_CONFIG,
  LIQUIDATION_DISTANCE_PRESET,
  amountForHf,
  evaluate,
  ewmaHourlyVol,
  formatPositionAlert,
  dryRunTelegram,
  initialEngineState,
  isNotifiable,
  quantile,
  replay,
  scoreReplay,
  setAndForgetSteps,
  summariseLeads,
  type AlertConfig,
  type LevelSpec,
  type PositionSnapshot,
  type PriceGrid,
  type ReplayStep,
  type Score,
} from '../../lib/positionAlerts'

const ROOT = process.cwd()
const DATASETS = datasetsDir(ROOT)
const DATA = join(DATASETS, 'position-alerts')
const PUBLIC_RESULTS = join(ROOT, 'docs', 'research', 'position-alerts-backtest-results.json')
const H = 3600
const D = 86400
const load = (p: string) => JSON.parse(readFileSync(join(DATASETS, p), 'utf8'))
const iso = (t: number) => new Date(t * 1000).toISOString().slice(0, 16).replace('T', ' ')
const round = (v: number | null, dp = 3) => (v === null || !Number.isFinite(v) ? v : +v.toFixed(dp))
const t0 = Date.now()
const log = (...a: unknown[]) => console.log(`[${((Date.now() - t0) / 1000).toFixed(0)}s]`, ...a)

// ------------------------------------------------------------------ configs under test

const OFF: AlertConfig = {
  healthFactor: null,
  ltv: null,
  liquidationDistance: null,
  cushionBurn: null,
  depeg: null,
  exitCapacity: null,
  oracleChange: null,
  targetHf: 1.3,
}
const ANTI_FLAP = { band: 0.03, dwellS: 2 * H, confirm: 1, cooldownS: 6 * H }

/** One-threshold spec: everything enters at `warn`, so minLevel 2 scores exactly this line. */
const single = (
  direction: 'below' | 'above',
  thr: number,
  af: Partial<LevelSpec> = {},
): LevelSpec => ({
  direction,
  enter: { warn: thr },
  ...ANTI_FLAP,
  ...af,
})

const hfSingle = (thr: number, af: Partial<LevelSpec> = {}): AlertConfig => ({
  ...OFF,
  healthFactor: single('below', thr, af),
})
const distSingle = (thr: number): AlertConfig => ({
  ...OFF,
  liquidationDistance: {
    ...LIQUIDATION_DISTANCE_PRESET,
    mode: 'static',
    spec: single('below', thr, { band: 0.02 }),
  },
})
const sigmaSingle = (thr: number): AlertConfig => ({
  ...OFF,
  liquidationDistance: {
    ...LIQUIDATION_DISTANCE_PRESET,
    mode: 'sigma',
    sigmaSpec: single('below', thr, { band: 0.25 }),
    // without a vol reading the rule falls back to a line nobody crosses, so the sweep
    // scores sigma alone
    spec: single('below', -1),
  },
})
const burnSingle = (thr: number): AlertConfig => ({
  ...OFF,
  cushionBurn: { ...DEFAULT_ALERT_CONFIG.cushionBurn!, spec: single('above', thr, { band: 0.1 }) },
})

const HF_SWEEP = [1.03, 1.05, 1.08, 1.1, 1.15, 1.2, 1.25, 1.3, 1.4, 1.5]
const DIST_SWEEP = [0.03, 0.05, 0.07, 0.1, 0.15, 0.2, 0.25]
const SIGMA_SWEEP = [0.5, 1, 1.5, 2, 2.5, 3, 4]
const BURN_SWEEP = [0.2, 0.3, 0.5, 0.75]

interface Variant {
  name: string
  config: AlertConfig
}
const sweepVariants = (): Variant[] => [
  ...HF_SWEEP.map((t) => ({ name: `hf<${t}`, config: hfSingle(t) })),
  ...DIST_SWEEP.map((t) => ({ name: `dist<${t}`, config: distSingle(t) })),
  ...SIGMA_SWEEP.map((t) => ({ name: `sigma<${t}`, config: sigmaSingle(t) })),
  ...BURN_SWEEP.map((t) => ({ name: `burn>${t}`, config: burnSingle(t) })),
]

/** Recommended tiered config (the default) and the same thresholds with anti-flap off. */
// Candidate tier sets, spelled out (not read from DEFAULT_ALERT_CONFIG) so the comparison
// stays fixed when the default changes. The default is scored alongside them.
const HF_TIERS: LevelSpec = {
  direction: 'below',
  enter: { watch: 1.3, warn: 1.15, critical: 1.05 },
  ...ANTI_FLAP,
}
const burnTiers = (enter: LevelSpec['enter']): AlertConfig['cushionBurn'] => ({
  lookbackS: 6 * H,
  maxHf: 1.5,
  spec: { direction: 'above', enter, ...ANTI_FLAP, band: 0.1 },
})
const sigmaTiers = (enter: LevelSpec['enter']): AlertConfig['liquidationDistance'] => ({
  mode: 'sigma',
  horizonH: 24,
  sigmaSpec: { direction: 'below', enter, ...ANTI_FLAP, band: 0.25 },
  spec: { direction: 'below', enter: { warn: -1 }, ...ANTI_FLAP },
})
const tieredVariants = (): Variant[] => [
  { name: 'DEFAULT_ALERT_CONFIG', config: DEFAULT_ALERT_CONFIG },
  { name: 'HF tiers only', config: { ...OFF, healthFactor: HF_TIERS } },
  {
    name: 'HF + burn crit .5',
    config: { ...OFF, healthFactor: HF_TIERS, cushionBurn: burnTiers({ critical: 0.5 }) },
  },
  {
    name: 'HF + burn .5/.75',
    config: {
      ...OFF,
      healthFactor: HF_TIERS,
      cushionBurn: burnTiers({ warn: 0.5, critical: 0.75 }),
    },
  },
  {
    name: 'HF + burn .3/.5',
    config: {
      ...OFF,
      healthFactor: HF_TIERS,
      cushionBurn: burnTiers({ warn: 0.3, critical: 0.5 }),
    },
  },
  {
    name: 'HF + burn .3/.5 + sigma 2/1',
    config: {
      ...OFF,
      healthFactor: HF_TIERS,
      cushionBurn: burnTiers({ warn: 0.3, critical: 0.5 }),
      liquidationDistance: sigmaTiers({ warn: 2, critical: 1 }),
    },
  },
  {
    name: 'HF + burn .3/.5/.75 + sigma 3/2/1',
    config: {
      ...OFF,
      healthFactor: HF_TIERS,
      cushionBurn: burnTiers({ watch: 0.3, warn: 0.5, critical: 0.75 }),
      liquidationDistance: sigmaTiers({ watch: 3, warn: 2, critical: 1 }),
    },
  },
  {
    name: 'HF tiers, no anti-flap',
    config: { ...OFF, healthFactor: { ...HF_TIERS, band: 0, dwellS: 0, cooldownS: 0 } },
  },
]

// ------------------------------------------------------------------ scoring aggregation

interface Row {
  variant: string
  replays: number
  liquidations: number
  /** distinct UTC days with a liquidation — the effective sample size for overlapping windows */
  liquidationDays: number
  missed: number
  censored: number
  medianLeadMin: number | null
  p10LeadMin: number | null
  p90LeadMin: number | null
  warned15m: number
  warned1h: number
  warned4h: number
  /** worsening messages (>= minLevel) with no liquidation inside the horizon, per position per 30 days, over positions never liquidated */
  falseAlarmsPer30d: number | null
  /** share of never-liquidated positions that got at least one such message */
  falseAlarmPositionShare: number | null
  /** of decided worsening messages, the share followed by a liquidation inside the horizon */
  precision: number | null
  messagesPer30d: number | null
}

interface Run {
  score: Score
  liquidatedAt: number | null
  firstTs: number | null
  lastTs: number | null
  /** worsening messages at >= minLevel after the first read (the opening state is not an alarm) */
  laterFalse: number
}

function scoreRun(r: ReturnType<typeof replay>, minLevel: 1 | 2 | 3, horizonS: number): Run {
  const score = scoreReplay(r, { minLevel, horizonS })
  // false alarms excluding a message at the very first read (a position opened inside a band)
  let laterFalse = 0
  for (const a of r.messages) {
    if (
      (a.transition !== 'fire' && a.transition !== 'escalate') ||
      a.to < minLevel ||
      a.ts === r.firstEvalTs
    )
      continue
    const liq = r.liquidatedAt
    const decided = liq !== null || (r.lastTs !== null && a.ts + horizonS <= r.lastTs)
    if (decided && !(liq !== null && liq > a.ts && liq <= a.ts + horizonS)) laterFalse++
  }
  return {
    score,
    liquidatedAt: r.liquidatedAt,
    firstTs: r.firstEvalTs,
    lastTs: r.lastTs,
    laterFalse,
  }
}

function aggregate(variant: string, runs: Run[]): Row {
  const scores = runs.map((r) => r.score)
  const lead = summariseLeads(scores)
  const calm = runs.filter((r) => !r.score.liquidated && r.firstTs !== null && r.lastTs !== null)
  const calmDays = calm.reduce((a, r) => a + ((r.lastTs as number) - (r.firstTs as number)) / D, 0)
  const calmFalse = calm.reduce((a, r) => a + r.laterFalse, 0)
  const allDays = runs.reduce(
    (a, r) => a + (r.firstTs !== null && r.lastTs !== null ? (r.lastTs - r.firstTs) / D : 0),
    0,
  )
  const decided = scores.reduce((a, s) => a + s.trueAlarms + s.falseAlarms, 0)
  const liqDays = new Set(
    runs
      .filter((r) => r.liquidatedAt !== null)
      .map((r) => Math.floor((r.liquidatedAt as number) / D)),
  )
  const m = (s: number | null) => (s === null ? null : round(s / 60, 1))
  return {
    variant,
    replays: runs.length,
    liquidations: lead.liquidations,
    liquidationDays: liqDays.size,
    missed: lead.missed,
    censored: lead.censored,
    medianLeadMin: m(lead.median),
    p10LeadMin: m(lead.p10),
    p90LeadMin: m(lead.p90),
    warned15m: round(lead.atLeast15m, 3) as number,
    warned1h: round(lead.atLeast1h, 3) as number,
    warned4h: round(lead.atLeast4h, 3) as number,
    falseAlarmsPer30d: calmDays > 0 ? round((calmFalse / calmDays) * 30, 3) : null,
    falseAlarmPositionShare: calm.length
      ? round(calm.filter((r) => r.laterFalse > 0).length / calm.length, 3)
      : null,
    precision: decided ? round(scores.reduce((a, s) => a + s.trueAlarms, 0) / decided, 3) : null,
    messagesPer30d:
      allDays > 0 ? round((scores.reduce((a, s) => a + s.messages, 0) / allDays) * 30, 3) : null,
  }
}

function printRows(title: string, rows: Row[]) {
  console.log(`\n== ${title}`)
  console.log(
    'variant'.padEnd(30),
    'liq'.padStart(5),
    'days'.padStart(5),
    'miss'.padStart(5),
    'cens'.padStart(5),
    'medLead'.padStart(8),
    'p10'.padStart(7),
    '>=15m'.padStart(6),
    '>=1h'.padStart(6),
    'FA/30d'.padStart(7),
    'FApos'.padStart(6),
    'prec'.padStart(6),
  )
  for (const r of rows) {
    console.log(
      r.variant.padEnd(30),
      String(r.liquidations).padStart(5),
      String(r.liquidationDays).padStart(5),
      String(r.missed).padStart(5),
      String(r.censored).padStart(5),
      String(r.medianLeadMin ?? '-').padStart(8),
      String(r.p10LeadMin ?? '-').padStart(7),
      String(r.warned15m).padStart(6),
      String(r.warned1h).padStart(6),
      String(r.falseAlarmsPer30d ?? '-').padStart(7),
      String(r.falseAlarmPositionShare ?? '-').padStart(6),
      String(r.precision ?? '-').padStart(6),
    )
  }
}

// ------------------------------------------------------------------ data

const hourly = JSON.parse(readFileSync(join(DATA, 'hourly-eth-btc.json'), 'utf8'))
const HOURLY: Record<'ETH' | 'BTC', PriceGrid> = {
  ETH: {
    startTs: hourly.startTs,
    stepS: H,
    close: hourly.columns.ethClose,
    low: hourly.columns.ethLow,
  },
  BTC: {
    startTs: hourly.startTs,
    stepS: H,
    close: hourly.columns.btcClose,
    low: hourly.columns.btcLow,
  },
}
const VOL_HALF_LIFE_H = 24
const HOURLY_VOL = {
  ETH: ewmaHourlyVol(HOURLY.ETH, VOL_HALF_LIFE_H, 48),
  BTC: ewmaHourlyVol(HOURLY.BTC, VOL_HALF_LIFE_H, 48),
}

/** Hourly vol in force at `ts`: the last hourly bar whose close is <= ts. Lookahead-free. */
function volAt(asset: 'ETH' | 'BTC', ts: number): number | undefined {
  const i = Math.floor((ts - hourly.startTs) / H) - 1
  const v = HOURLY_VOL[asset][i]
  return Number.isFinite(v) ? v : undefined
}

const LT = { ETH: 0.83, BTC: 0.78 } // Aave V3 mainnet WETH / WBTC liquidation thresholds

// ------------------------------------------------------------------ experiment H: hourly history

const HF0S = [1.25, 1.5, 2.0]
const WINDOW_D = 30

type Replay = ReturnType<typeof replay>
const scoreAll = (rs: Replay[], minLevel: 1 | 2 | 3): Run[] =>
  rs.map((r) => scoreRun(r, minLevel, 72 * H))

const HOURLY_EVERY_D = 2

function hourlyReplays(config: AlertConfig, everyD = HOURLY_EVERY_D): Replay[] {
  const runs: Replay[] = []
  for (const asset of ['ETH', 'BTC'] as const) {
    const g = HOURLY[asset]
    const n = g.close.length
    for (let s = 48; s + WINDOW_D * 24 < n; s += 24 * everyD) {
      const p0 = g.close[s]
      if (p0 === null) continue
      for (const hf0 of HF0S) {
        const steps = setAndForgetSteps({
          id: `${asset}-${s}-${hf0}`,
          venue: 'synthetic',
          symbol: asset,
          amount: amountForHf(hf0, 100_000, p0, LT[asset]),
          debtUsd: 100_000,
          liquidationThreshold: LT[asset],
          grid: g,
          startIdx: s,
          endIdx: s + WINDOW_D * 24,
          vol: HOURLY_VOL[asset],
        })
        runs.push(replay(steps, config))
      }
    }
  }
  return runs
}

/** Non-overlapping 30-day windows where ETH and BTC each stayed within `maxDd` of their running peak. */
function calmWindows(
  maxDd: number,
): { start: number; idx: number; ethDd: number; btcDd: number }[] {
  const n = HOURLY.ETH.close.length
  const dd = (g: PriceGrid, s: number) => {
    let peak = g.close[s] as number
    let worst = 0
    for (let i = s; i <= s + WINDOW_D * 24; i++) {
      const c = g.close[i]
      const l = g.low?.[i] ?? c
      if (c === null || l === null) continue
      if (c > peak) peak = c
      worst = Math.max(worst, 1 - l / peak)
    }
    return worst
  }
  const out = []
  for (let s = 48; s + WINDOW_D * 24 < n; ) {
    const e = dd(HOURLY.ETH, s)
    const b = dd(HOURLY.BTC, s)
    if (e < maxDd && b < maxDd) {
      out.push({
        start: HOURLY.ETH.startTs + s * H,
        idx: s,
        ethDd: round(e, 3) as number,
        btcDd: round(b, 3) as number,
      })
      s += WINDOW_D * 24
    } else s += 24
  }
  return out
}

function calmReplays(
  config: AlertConfig,
  windows: ReturnType<typeof calmWindows>,
  hf0s = [1.2, 1.25, 1.5],
): Replay[] {
  const runs: Replay[] = []
  for (const w of windows) {
    for (const asset of ['ETH', 'BTC'] as const) {
      const g = HOURLY[asset]
      for (const hf0 of hf0s) {
        const steps = setAndForgetSteps({
          id: `calm-${asset}-${w.idx}-${hf0}`,
          venue: 'synthetic',
          symbol: asset,
          amount: amountForHf(hf0, 100_000, g.close[w.idx] as number, LT[asset]),
          debtUsd: 100_000,
          liquidationThreshold: LT[asset],
          grid: g,
          startIdx: w.idx,
          endIdx: w.idx + WINDOW_D * 24,
          vol: HOURLY_VOL[asset],
        })
        runs.push(replay(steps, config))
      }
    }
  }
  return runs
}

// ------------------------------------------------------------------ experiment E1: Oct 10 2025, real Aave accounts

const STABLE_DEBT = new Set(['USDC', 'USDT', 'USD₮0', 'USDbC', 'GHO', 'DAI'])
const E1_FEED: Record<string, { col: string; asset: 'ETH' | 'BTC' }> = {
  WETH: { col: 'ethOracle', asset: 'ETH' },
  wstETH: { col: 'wstethOracle', asset: 'ETH' },
  WBTC: { col: 'btcOracle', asset: 'BTC' },
  cbBTC: { col: 'btcOracle', asset: 'BTC' },
}

interface CohortRow {
  user: string
  chain: string
  t0Index: number
  t0Ts: number
  pStateColl: number
  collateralUsd: number
  debtUsd: number
  healthFactor: number
  liqLine: number
  collSymbol: string
  debtSymbol: string
  priced: boolean
  excluded: boolean
}

const e1Prices = load('oct10-2025/prices-1m.json')
const e1Cohort: CohortRow[] = (
  load('oct10-2025/evidence.json').cohort as CohortRow[]
).filter(
  (r) =>
    r.priced &&
    !r.excluded &&
    E1_FEED[r.collSymbol] &&
    STABLE_DEBT.has(r.debtSymbol) &&
    r.debtUsd > 0,
)

function* e1Steps(r: CohortRow): Generator<ReplayStep> {
  const feed = E1_FEED[r.collSymbol]
  const col: (number | null)[] = e1Prices.columns[feed.col]
  const amount = r.collateralUsd / r.pStateColl
  const w = amount * r.liqLine
  for (let i = 0; i < r.t0Index; i++) {
    const p = col[i]
    const ts = e1Prices.startTs + i * 60
    if (p === null) continue
    const sigma = volAt(feed.asset, ts)
    yield {
      ts,
      intervalStart: ts,
      worstHf: (w * p) / r.debtUsd,
      snapshot: {
        id: r.user,
        ts,
        venue: `Aave V3 ${r.chain}`,
        collateral: [
          { symbol: r.collSymbol, amount, oraclePriceUsd: p, liquidationThreshold: r.liqLine },
        ],
        debt: [{ symbol: r.debtSymbol, amount: r.debtUsd, priceUsd: 1 }],
      },
      ctx: sigma ? { hourlyVol: { [r.collSymbol]: sigma } } : {},
    }
  }
}

function e1Replays(config: AlertConfig, everyS: number): Replay[] {
  return e1Cohort.map((r) =>
    replay(e1Steps(r), config, { monitorEveryS: everyS, knownLiquidationTs: r.t0Ts }),
  )
}

// ------------------------------------------------------------------ experiment E2: Nov 2025, real Morpho positions

interface MorphoPosition {
  user: string
  marketId: string
  collateral: string
  loan: string
  lltv: number
  liquidations: { ts: number; seized: number; repaid: number; badDebt: number }[]
  history: { ts: number; collateral: number; collateralUsd?: number; borrow?: number }[]
}

const e2 = JSON.parse(readFileSync(join(DATA, 'e2-nov-2025.json'), 'utf8'))
const E2_SPOT: Record<'ETH' | 'BTC', PriceGrid> = {
  ETH: {
    startTs: e2.spot1m.startTs,
    stepS: 60,
    close: e2.spot1m.columns.ethClose,
    low: e2.spot1m.columns.ethLow,
  },
  BTC: {
    startTs: e2.spot1m.startTs,
    stepS: 60,
    close: e2.spot1m.columns.btcClose,
    low: e2.spot1m.columns.btcLow,
  },
}
const e2Asset = (sym: string): 'ETH' | 'BTC' => (sym === 'wstETH' ? 'ETH' : 'BTC')

/** History point in force at ts (last with point.ts <= ts). */
function inForce<T extends { ts: number }>(h: T[], ts: number): T | null {
  let lo = 0
  let hi = h.length - 1
  let best: T | null = null
  while (lo <= hi) {
    const mid = (lo + hi) >> 1
    if (h[mid].ts <= ts) {
      best = h[mid]
      lo = mid + 1
    } else hi = mid - 1
  }
  return best
}

interface E2Prepared {
  p: MorphoPosition
  hist: { ts: number; collateral: number; borrow: number; collateralUsd: number }[]
  /** collateral USD per unit / spot close — wstETH wrap rate, WBTC basis */
  scale: number
  liqTs: number
}

const e2Prepared: E2Prepared[] = (e2.morpho.positions as MorphoPosition[])
  .map((p) => {
    const hist = p.history
      .filter((x) => (x.borrow ?? 0) > 0 && x.collateral > 0 && (x.collateralUsd ?? 0) > 0)
      .map((x) => ({
        ts: x.ts,
        collateral: x.collateral,
        borrow: x.borrow as number,
        collateralUsd: x.collateralUsd as number,
      }))
    const g = E2_SPOT[e2Asset(p.collateral)]
    const ratios: number[] = []
    for (const x of hist) {
      const i = Math.floor((x.ts - g.startTs) / 60)
      const c = g.close[i]
      if (c) ratios.push(x.collateralUsd / x.collateral / c)
    }
    const liqTs = p.liquidations[0].ts
    return { p, hist: hist.filter((x) => x.ts < liqTs), scale: quantile(ratios, 0.5) ?? NaN, liqTs }
  })
  .filter(
    (x) => x.hist.length >= 24 && Number.isFinite(x.scale) && x.liqTs > E2_SPOT.ETH.startTs + 2 * D,
  )

function* e2Steps(x: E2Prepared): Generator<ReplayStep> {
  const asset = e2Asset(x.p.collateral)
  const g = E2_SPOT[asset]
  const from = Math.max(x.hist[0].ts, g.startTs)
  for (let t = from; t < x.liqTs; t += 60) {
    const i = Math.floor((t - g.startTs) / 60)
    const close = g.close[i]
    const low = g.low?.[i] ?? close
    const h = inForce(x.hist, t)
    if (close === null || low === null || !h) continue
    const amount = h.collateral
    const w = amount * x.scale * x.p.lltv
    const sigma = volAt(asset, t + 60)
    yield {
      ts: t + 60,
      intervalStart: t,
      worstHf: (w * low) / h.borrow,
      snapshot: {
        id: x.p.user,
        ts: t + 60,
        venue: `Morpho ${x.p.collateral}/${x.p.loan}`,
        collateral: [
          {
            symbol: x.p.collateral,
            amount,
            oraclePriceUsd: close * x.scale,
            liquidationThreshold: x.p.lltv,
          },
        ],
        debt: [{ symbol: x.p.loan, amount: h.borrow, priceUsd: 1 }],
      },
      ctx: sigma ? { hourlyVol: { [x.p.collateral]: sigma } } : {},
    }
  }
}

function e2Replays(config: AlertConfig, everyS: number): Replay[] {
  return e2Prepared.map((x) =>
    replay(e2Steps(x), config, { monitorEveryS: everyS, knownLiquidationTs: x.liqTs }),
  )
}

// ------------------------------------------------------------------ experiment E4: Aug 25 2026, PT-reUSD

const e4 = JSON.parse(readFileSync(join(DATA, 'e4-aug-2026.json'), 'utf8'))
const e4Oracle: { ts: number; price: number }[] = (e4.oracle.points as [number, number, number][])
  .map(([ts, , price]) => ({ ts, price }))
  .sort((a, b) => a.ts - b.ts)

interface E4Prepared {
  p: MorphoPosition
  hist: { ts: number; collateral: number; borrow: number }[]
  liqTs: number
}
const e4Prepared: E4Prepared[] = (e4.morpho.positions as MorphoPosition[])
  .filter((p) => p.collateral === 'PT-reUSD-10DEC2026')
  .map((p) => ({
    p,
    hist: p.history
      .filter((x) => (x.borrow ?? 0) > 0 && x.collateral > 0)
      .map((x) => ({ ts: x.ts, collateral: x.collateral, borrow: x.borrow as number })),
    liqTs: p.liquidations[0].ts,
  }))
  .filter((x) => x.hist.length >= 6)

/** Trailing hourly vol of the PT oracle, from its own samples (EWMA, lookahead-free). */
const e4VolGrid: PriceGrid = (() => {
  const start = Math.floor(e4Oracle[0].ts / H) * H
  const n = Math.ceil((e4Oracle[e4Oracle.length - 1].ts - start) / H) + 1
  const close: (number | null)[] = []
  for (let i = 0; i < n; i++) close.push(inForce(e4Oracle, start + (i + 1) * H)?.price ?? null)
  return { startTs: start, stepS: H, close }
})()
const e4Vol = ewmaHourlyVol(e4VolGrid, VOL_HALF_LIFE_H, 48)
const e4VolAt = (ts: number) => {
  const v = e4Vol[Math.floor((ts - e4VolGrid.startTs) / H) - 1]
  return Number.isFinite(v) ? v : undefined
}

function* e4Steps(x: E4Prepared): Generator<ReplayStep> {
  const from = Math.max(x.hist[0].ts, e4Oracle[0].ts)
  for (let t = from; t < x.liqTs; t += 60) {
    const o = inForce(e4Oracle, t)
    const h = inForce(x.hist, t)
    if (!o || !h) continue
    const w = h.collateral * o.price * x.p.lltv
    const sigma = e4VolAt(t)
    yield {
      ts: t,
      intervalStart: t,
      worstHf: w / h.borrow,
      snapshot: {
        id: x.p.user,
        ts: t,
        venue: `Morpho PT-reUSD/${x.p.loan} 91.5%`,
        collateral: [
          {
            symbol: 'PT-reUSD',
            amount: h.collateral,
            oraclePriceUsd: o.price,
            liquidationThreshold: x.p.lltv,
          },
        ],
        debt: [{ symbol: x.p.loan, amount: h.borrow, priceUsd: 1 }],
      },
      ctx: sigma ? { hourlyVol: { 'PT-reUSD': sigma } } : {},
    }
  }
}

function e4Replays(config: AlertConfig, everyS: number): Replay[] {
  return e4Prepared.map((x) =>
    replay(e4Steps(x), config, { monitorEveryS: everyS, knownLiquidationTs: x.liqTs }),
  )
}

// ------------------------------------------------------------------ experiment E3: Apr 2026 Kelp rsETH

type DepegSeries = [number, number][]

const e3 = load('position-alerts/e3-apr-2026.json')
const E3_INCIDENT = Date.parse('2026-04-18T19:03:59Z') / 1000 // Aave rsETH freeze
const rsRatio: DepegSeries = (() => {
  const ethByHour = new Map<number, number>(
    (e3.depeg.ETH.points as DepegSeries).map(([t, p]) => [Math.floor(t / H), p]),
  )
  const out: DepegSeries = []
  for (const [t, p] of e3.depeg.rsETH.points as DepegSeries) {
    const e = ethByHour.get(Math.floor(t / H))
    if (e) out.push([t, p / e])
  }
  return out
})()
/** Redemption-rate proxy: median rsETH/ETH over the week before the incident. */
const rsRate = quantile(
  rsRatio.filter(([t]) => t < E3_INCIDENT - 24 * H).map(([, r]) => r),
  0.5,
) as number
const rsVsPeg: DepegSeries = rsRatio.map(([t, r]) => [t, r / rsRate])

/**
 * An rsETH/ETH loop (rsETH collateral, ETH debt, e-mode style LT 0.93), opened at the
 * pre-incident fair price. Priced in ETH. On a venue whose oracle follows the market ratio
 * the depeg can liquidate it; on an exchange-rate oracle it cannot, and only the depeg rule
 * speaks.
 */
function* rsLoopSteps(basis: 'market' | 'exchangeRate', hf0: number): Generator<ReplayStep> {
  const lt = 0.93
  const debt = 100
  const amount = (hf0 * debt) / (rsRate * lt)
  let prev = rsRatio[0][0]
  for (const [ts, ratio] of rsRatio) {
    const oracle = basis === 'market' ? ratio : rsRate
    yield {
      ts,
      intervalStart: prev,
      worstHf: (amount * oracle * lt) / debt,
      snapshot: {
        id: `rsETH-${basis}-${hf0}`,
        ts,
        venue:
          basis === 'market'
            ? 'rsETH/ETH loop · market oracle'
            : 'rsETH/ETH loop · exchange-rate oracle',
        collateral: [
          {
            symbol: 'rsETH',
            amount,
            oraclePriceUsd: oracle,
            marketPriceUsd: ratio,
            liquidationThreshold: lt,
            oracleBasis: basis,
            peg: { class: 'lst', underlying: 'ETH', rate: rsRate },
          },
        ],
        debt: [{ symbol: 'ETH', amount: debt, priceUsd: 1 }],
      },
      ctx: { underlyingUsd: { ETH: 1 } },
    }
    prev = ts
  }
}

const E3_ETH: PriceGrid = {
  startTs: e3.spot1m.startTs,
  stepS: 60,
  close: e3.spot1m.columns.ethClose,
  low: e3.spot1m.columns.ethLow,
}
const E3_ETH_VOL = Float64Array.from(
  E3_ETH.close,
  (_, i) => volAt('ETH', E3_ETH.startTs + (i + 1) * 60) ?? NaN,
)

/** ETH/USD positions held over the Apr 2026 one-minute path, opened Apr 12 00:00. */
function e3EthReplays(config: AlertConfig, hf0s = [1.1, 1.25, 1.5]): Replay[] {
  const start = 2 * 24 * 60
  return hf0s.map((hf0) =>
    replay(
      setAndForgetSteps({
        id: `e3-eth-${hf0}`,
        venue: 'synthetic',
        symbol: 'ETH',
        amount: amountForHf(hf0, 100_000, E3_ETH.close[start] as number, LT.ETH),
        debtUsd: 100_000,
        liquidationThreshold: LT.ETH,
        grid: E3_ETH,
        startIdx: start,
        endIdx: E3_ETH.close.length - 1,
        vol: E3_ETH_VOL,
      }),
      config,
    ),
  )
}

// ------------------------------------------------------------------ depeg replays (E2 deUSD, E3 rsETH, history)

interface DepegEpisode {
  firstTs: string
  severity: string
  peakBps: number
}

/** Replay the depeg rule alone on a [ts, ratioToPeg] series; returns messages and episodes. */
function depegReplay(series: DepegSeries, cls: 'stable' | 'lst', spec?: LevelSpec) {
  const cfg: AlertConfig = {
    ...OFF,
    depeg: { ...DEFAULT_ALERT_CONFIG.depeg!, ...(spec ? { [cls]: spec } : {}) },
  }
  let state = initialEngineState()
  const messages: { ts: number; severity: string; transition: string; value: number }[] = []
  for (const [ts, ratio] of series) {
    const s: PositionSnapshot = {
      id: 'depeg',
      ts,
      venue: 'replay',
      collateral: [
        {
          symbol: 'X',
          amount: 1,
          oraclePriceUsd: 1,
          marketPriceUsd: ratio,
          liquidationThreshold: 0.8,
          peg: { class: cls, underlying: 'USD', rate: 1 },
        },
      ],
      debt: [{ symbol: 'USD', amount: 0.5, priceUsd: 1 }],
    }
    const r = evaluate(s, {}, state, cfg)
    state = r.state
    for (const a of r.alerts.filter((a) => isNotifiable(a)))
      messages.push({
        ts,
        severity: a.severity,
        transition: a.transition,
        value: round(a.value, 0) as number,
      })
  }
  return messages
}

function depegStats(series: DepegSeries, cls: 'stable' | 'lst', spec?: LevelSpec) {
  const msgs = depegReplay(series, cls, spec)
  const days = series.length ? (series[series.length - 1][0] - series[0][0]) / D : 0
  const worsening = msgs.filter((m) => m.transition === 'fire' || m.transition === 'escalate')
  const episodes: DepegEpisode[] = []
  for (const m of worsening) {
    if (m.transition === 'fire')
      episodes.push({ firstTs: iso(m.ts), severity: m.severity, peakBps: m.value })
    else if (episodes.length) {
      const e = episodes[episodes.length - 1]
      e.severity = m.severity
      e.peakBps = Math.max(e.peakBps, m.value)
    }
  }
  return {
    from: series.length ? iso(series[0][0]) : null,
    to: series.length ? iso(series[series.length - 1][0]) : null,
    days: round(days, 1),
    worseningMessages: worsening.length,
    messagesPer30d: days > 0 ? round((worsening.length / days) * 30, 3) : null,
    warnPlusPer30d:
      days > 0
        ? round((worsening.filter((m) => m.severity !== 'watch').length / days) * 30, 3)
        : null,
    episodes,
  }
}

// ------------------------------------------------------------------ main

// ------------------------------------------------------------------ dry-run sample + public copy

const SYNTHETIC_ID = '0x0000000000000000000000000000000000000000'

/** The first warn-or-higher fire or escalation of a replay, formatted as a dry-run message. */
function firstPushedMessage(steps: Iterable<ReplayStep>): ReturnType<typeof dryRunTelegram> | null {
  let st = initialEngineState()
  for (const step of steps) {
    if (!step.snapshot) continue
    const r = evaluate(step.snapshot, step.ctx ?? {}, st, DEFAULT_ALERT_CONFIG)
    st = r.state
    const n = r.alerts.filter((a) => isNotifiable(a))
    if (
      n.some(
        (a) => a.severity !== 'watch' && (a.transition === 'fire' || a.transition === 'escalate'),
      )
    ) {
      const text = formatPositionAlert({
        alerts: n,
        snapshot: step.snapshot,
        metrics: r.metrics,
        targetHf: DEFAULT_ALERT_CONFIG.targetHf,
      })
      return text ? dryRunTelegram('dry-run', text) : null
    }
  }
  return null
}

/**
 * The results with no wallet identifier: the real-replay sample message is swapped for the
 * synthetic one. Throws if any address or shortened address other than the synthetic one is left.
 */
function publicCopy(results: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {
    ...results,
    sampleMessage: results.sampleMessageSynthetic ?? null,
  }
  delete out.sampleMessageSynthetic
  const text = JSON.stringify(out)
  const leaks = [
    ...(text.match(/0x[0-9a-fA-F]{40}/g) ?? []),
    ...(text.match(/0x[0-9a-fA-F]{4}\u2026[0-9a-fA-F]{4}/g) ?? []),
  ].filter((m) => m !== SYNTHETIC_ID && m !== '0x0000\u20260000')
  if (leaks.length) throw new Error(`public results still hold wallet identifiers: ${leaks.join(', ')}`)
  return out
}

function main() {
  const results: Record<string, unknown> = {
    generatedBy: 'scripts/research/position-alert-backtest.ts',
    generatedAt: new Date().toISOString(),
    defaults: DEFAULT_ALERT_CONFIG,
    method: {
      volatility: `EWMA of 1h log returns, half-life ${VOL_HALF_LIFE_H}h, read from the last completed hour (lookahead-free)`,
      hourly: `synthetic single-collateral positions, debt $100k stable, opened every ${HOURLY_EVERY_D} days at 00:00 UTC at HF ${HF0S.join('/')}, held ${WINDOW_D} days untouched; monitor reads each hourly close; liquidation when the hourly LOW takes HF < 1, stamped at the bar open`,
      e1: 'real Aave V3 accounts liquidated Oct 10 2025 (evidence.json cohort: priced, not excluded, WETH/wstETH/WBTC/cbBTC collateral, stable debt); balances held at their liquidation snapshot and re-priced backwards on the mainnet Chainlink feed in force each minute; liquidation time = the real first liquidation',
      e2: 'real Morpho Blue positions liquidated in Nov 2025 (WBTC/cbBTC/wstETH collateral, stable loan); hourly collateral and borrow from the Morpho API, priced each minute on Binance spot scaled to Morpho collateral USD; liquidation time = the real first liquidation. NOT the Recall Coverage Dataset spec E2 (Stream xUSD freeze, Nov 2–12): see e2SpecWindow and depeg.e2DeUSD',
      e4: 'real Morpho PT-reUSD-10DEC2026 positions liquidated Aug 25 2026; hourly collateral/borrow from the Morpho API, priced on the market oracle (archive reads every ~1h, every 5 blocks 01:00-07:00 UTC Aug 25); liquidation time = the real first liquidation',
      falseAlarm:
        'a worsening message at >= the scored level with no liquidation in the next 72h, counted only on positions never liquidated, excluding a message at the first read (a position opened inside a band)',
    },
  }

  // ---- sweeps: single thresholds
  const skipSweeps = process.argv.includes('--skip-sweeps')
  log('hourly history sweep …')
  const sweep = () => (skipSweeps ? [] : sweepVariants())
  const hourlySweep = sweep().map((v) => aggregate(v.name, scoreAll(hourlyReplays(v.config), 2)))
  printRows(
    'H — hourly 2020→2026, synthetic set-and-forget, single threshold (scored at that line)',
    hourlySweep,
  )
  results.hourlySweep = hourlySweep

  const windows = calmWindows(0.1)
  log(`calm windows: ${windows.length}`)
  const calmSweep = sweep().map((v) =>
    aggregate(v.name, scoreAll(calmReplays(v.config, windows), 2)),
  )
  printRows(
    `CALM — ${windows.length} non-overlapping 30-day windows, ETH & BTC drawdown < 10%, HF0 1.2/1.25/1.5`,
    calmSweep,
  )
  results.calmWindows = windows.map((w) => ({
    start: iso(w.start),
    ethDd: w.ethDd,
    btcDd: w.btcDd,
  }))
  results.calmSweep = calmSweep

  log(`E1 cohort: ${e1Cohort.length} accounts`)
  const e1Sweep = sweep().map((v) => aggregate(v.name, scoreAll(e1Replays(v.config, 60), 2)))
  printRows(`E1 — Oct 10 2025, ${e1Cohort.length} real Aave accounts, 1-minute monitor`, e1Sweep)
  results.e1Sweep = e1Sweep

  log(`E2 positions: ${e2Prepared.length}`)
  const e2Sweep = sweep().map((v) => aggregate(v.name, scoreAll(e2Replays(v.config, 60), 2)))
  printRows(`E2 — Nov 2025, ${e2Prepared.length} real Morpho positions, 1-minute monitor`, e2Sweep)
  results.e2Sweep = e2Sweep

  log(`E4 positions: ${e4Prepared.length}`)
  const e4Sweep = sweep().map((v) => aggregate(v.name, scoreAll(e4Replays(v.config, 60), 2)))
  printRows(
    `E4 — Aug 25 2026, ${e4Prepared.length} real Morpho PT-reUSD positions, 1-minute monitor`,
    e4Sweep,
  )
  results.e4Sweep = e4Sweep

  // ---- monitor cadence (E1, E2): what a slower poller loses
  const cadence: Record<string, Row[]> = {}
  for (const everyS of [60, 5 * 60, 15 * 60, 60 * 60]) {
    for (const [set, run] of [
      ['E1', e1Replays],
      ['E2', e2Replays],
    ] as const) {
      const single115 = run(hfSingle(1.15), everyS)
      const single105 = run(hfSingle(1.05), everyS)
      const dflt = run(DEFAULT_ALERT_CONFIG, everyS)
      cadence[`${set} every ${everyS / 60}m`] = [
        aggregate('hf<1.15', scoreAll(single115, 2)),
        aggregate('hf<1.05', scoreAll(single105, 2)),
        aggregate('default (warn+)', scoreAll(dflt, 2)),
        aggregate('default (critical)', scoreAll(dflt, 3)),
      ]
    }
  }
  for (const [k, rows] of Object.entries(cadence)) printRows(`CADENCE — ${k}`, rows)
  results.cadence = cadence

  // ---- the recommended tiered config, scored at each level
  const tiered: Record<string, Row[]> = {}
  const sets: [string, (c: AlertConfig) => Replay[]][] = [
    ['H', (c) => hourlyReplays(c)],
    ['CALM', (c) => calmReplays(c, windows)],
    ['E1', (c) => e1Replays(c, 60)],
    ['E2', (c) => e2Replays(c, 60)],
    ['E4', (c) => e4Replays(c, 60)],
    ['E3-ETH', (c) => e3EthReplays(c)],
  ]
  const byHf0: Record<string, Row[]> = {}
  for (const [name, run] of sets) {
    const replays = tieredVariants().map((v) => ({ v, rs: run(v.config) }))
    for (const minLevel of [1, 2, 3] as const) {
      const lvl = ['', 'watch+', 'warn+', 'critical'][minLevel]
      tiered[`${name} ${lvl}`] = replays.map(({ v, rs }) =>
        aggregate(v.name, scoreAll(rs, minLevel)),
      )
    }
    // hourlyReplays loops asset → start → HF0, so index % HF0S.length is the opening HF
    if (name === 'H') {
      for (const minLevel of [1, 2] as const) {
        const lvl = ['', 'watch+', 'warn+'][minLevel]
        byHf0[`H ${lvl}`] = replays.flatMap(({ v, rs }) =>
          HF0S.map((hf0, k) =>
            aggregate(
              `${v.name} @HF0 ${hf0}`,
              scoreAll(
                rs.filter((_, i) => i % HF0S.length === k),
                minLevel,
              ),
            ),
          ),
        )
      }
    }
  }
  for (const [k, rows] of Object.entries(byHf0)) printRows(`BY OPENING HF — ${k}`, rows)
  results.byOpeningHf = byHf0
  for (const [k, rows] of Object.entries(tiered)) printRows(`TIERED — ${k}`, rows)
  results.tiered = tiered

  // ---- flapping: messages per liquidation-free calm position-month, anti-flap on vs off
  const flap = (cfg: AlertConfig) => {
    const runs = scoreAll(calmReplays(cfg, windows, [1.15, 1.2, 1.3, 1.35]), 1)
    const msgs = runs.reduce((a, r) => a + r.score.messages, 0)
    const days = runs.reduce((a, r) => a + ((r.lastTs ?? 0) - (r.firstTs ?? 0)) / D, 0)
    return { positions: runs.length, messagesPer30d: round((msgs / days) * 30, 2) }
  }
  results.flapping = {
    note: 'positions opened near the HF bands (1.15/1.2/1.3/1.35) in calm windows: every message counts, clears included',
    antiFlapOn: flap({ ...OFF, healthFactor: DEFAULT_ALERT_CONFIG.healthFactor }),
    antiFlapOff: flap({
      ...OFF,
      healthFactor: { ...DEFAULT_ALERT_CONFIG.healthFactor!, band: 0, dwellS: 0, cooldownS: 0 },
    }),
  }
  log('flapping', results.flapping)

  // ---- E1/E2/E4 alignment: modelled HF < 1 crossing vs the real liquidation
  const align = (runs: { modelled: number | null; actual: number }[]) => {
    const diffs = runs
      .filter((r) => r.modelled !== null)
      .map((r) => (r.actual - (r.modelled as number)) / 60)
    return {
      positions: runs.length,
      modelledCrossedBeforeActual: diffs.length,
      medianMinutesEarly: round(quantile(diffs, 0.5), 1),
      p90MinutesEarly: round(quantile(diffs, 0.9), 1),
    }
  }
  results.alignment = {
    note: 'how often the replayed path crosses HF 1 before the real liquidation, and by how much (minutes). A crossing that never happens means the reconstruction is conservative.',
    e1: align(
      e1Cohort.map((r) => ({
        modelled: replay(e1Steps(r), OFF, { knownLiquidationTs: r.t0Ts }).modelledLiquidationAt,
        actual: r.t0Ts,
      })),
    ),
    e2: align(
      e2Prepared.map((x) => ({
        modelled: replay(e2Steps(x), OFF, { knownLiquidationTs: x.liqTs }).modelledLiquidationAt,
        actual: x.liqTs,
      })),
    ),
    e4: align(
      e4Prepared.map((x) => ({
        modelled: replay(e4Steps(x), OFF, { knownLiquidationTs: x.liqTs }).modelledLiquidationAt,
        actual: x.liqTs,
      })),
    ),
  }
  log('alignment', results.alignment)

  // ---- E4 detail: the starting health factors and the oracle path into the cascade
  const e4StartHf = e4Prepared.map((x) => {
    const h = inForce(x.hist, x.liqTs - 3 * H) as { collateral: number; borrow: number }
    const o = inForce(e4Oracle, x.liqTs - 3 * H) as { price: number }
    return round((h.collateral * o.price * x.p.lltv) / h.borrow, 4) as number
  })
  // ---- E2 inside the Recall Coverage Dataset spec window (EV-2: Nov 2–12 2025)
  // The spec's E2 is the Stream xUSD freeze. This set is only the WBTC/cbBTC/wstETH Morpho
  // liquidations whose first liquidation falls inside that window: same dates, not the
  // xUSD-collateral clusters that define the event. Those are covered by the deUSD depeg row.
  const EV2_START = Date.parse('2025-11-02T00:00:00Z') / 1000
  const EV2_END = Date.parse('2025-11-13T00:00:00Z') / 1000
  const inEv2 = (ts: number) => ts >= EV2_START && ts < EV2_END
  const e2Window = e2Prepared.filter((x) => inEv2(x.liqTs))
  const e2WindowReplays = e2Window.map((x) =>
    replay(e2Steps(x), DEFAULT_ALERT_CONFIG, { monitorEveryS: 60, knownLiquidationTs: x.liqTs }),
  )
  results.e2SpecWindow = {
    note: 'Morpho WBTC/cbBTC/wstETH positions first liquidated inside the spec EV-2 window (Nov 2–12 2025), DEFAULT_ALERT_CONFIG, 1-minute monitor. Not the xUSD-collateral clusters.',
    positionsInData: (e2.morpho.positions as MorphoPosition[]).length,
    positionsInDataInWindow: (e2.morpho.positions as MorphoPosition[]).filter((p) =>
      inEv2(p.liquidations[0].ts),
    ).length,
    replayedInWindow: e2Window.length,
    warnPlus: aggregate('DEFAULT_ALERT_CONFIG', scoreAll(e2WindowReplays, 2)),
    critical: aggregate('DEFAULT_ALERT_CONFIG', scoreAll(e2WindowReplays, 3)),
  }
  log('e2 spec window', results.e2SpecWindow)

  const AUG25_0400 = Date.parse('2026-08-25T04:00:00Z') / 1000
  const at0400 = inForce(e4Oracle, AUG25_0400)?.price ?? NaN
  const firstDrop = e4Oracle.find((o) => o.ts > AUG25_0400 && o.price < at0400 * 0.999)
  results.e4Detail = {
    positions: e4Prepared.length,
    hfThreeHoursBefore: {
      min: Math.min(...e4StartHf),
      median: quantile(e4StartHf, 0.5),
      max: Math.max(...e4StartHf),
    },
    oracleAt0400: at0400,
    firstTickDown01pct: firstDrop ? iso(firstDrop.ts) : null,
    firstLiquidation: iso(Math.min(...e4Prepared.map((x) => x.liqTs))),
    lowestOracle: Math.min(...e4Oracle.map((o) => o.price)),
  }
  log('e4', results.e4Detail)

  // ---- depeg: calm rate on history, detection on E2 deUSD and E3 rsETH
  const depegHist = load('position-alerts/depeg-history.json').series
  const deusd: DepegSeries = e2.depeg.deUSD.points
  /** One E1 column as a [ts, value] series (1-minute, nulls dropped). */
  const oracleSeries = (col: string): DepegSeries =>
    (e1Prices.columns[col] as (number | null)[])
      .map((v, i): [number, number | null] => [e1Prices.startTs + i * 60, v])
      .filter((x): x is [number, number] => x[1] !== null)
  results.depeg = {
    rsEthRateProxy: {
      value: round(rsRate, 5),
      method:
        'median rsETH/ETH (DefiLlama, same source both legs) over Apr 10 → Apr 17 2026, used as the redemption-rate proxy',
    },
    stethEthHistory: depegStats(depegHist.stethEth, 'lst'),
    stethEthPostShanghai: depegStats(
      (depegHist.stethEth as DepegSeries).filter(
        ([t]) => t >= Date.parse('2023-04-12T22:27:35Z') / 1000,
      ),
      'lst',
    ),
    e1StethEthChainlink: depegStats(oracleSeries('stethEthOracle'), 'lst'),
    e1UsdeCurveQuote: depegStats(oracleSeries('usdeOnchain'), 'stable'),
    e1UsdeBinance: depegStats(oracleSeries('usdeSpotLow'), 'stable'),
    usdcHistory: depegStats(depegHist.usdc, 'stable'),
    usdeHistory: depegStats(depegHist.usde, 'stable'),
    e2DeUSD: depegStats(deusd, 'stable'),
    e3RsEth: depegStats(rsVsPeg, 'lst'),
    e3RsEthPreIncident: depegStats(
      rsVsPeg.filter(([t]) => t < E3_INCIDENT),
      'lst',
    ),
    e3RsEthFirstBelow95:
      (rsVsPeg.find(([, r]) => r < 0.95) ?? [null])[0] !== null
        ? iso((rsVsPeg.find(([, r]) => r < 0.95) as [number, number])[0])
        : null,
    e2DeUSDFirstBelow50c: deusd.find(([, p]) => p < 0.5)
      ? iso((deusd.find(([, p]) => p < 0.5) as [number, number])[0])
      : null,
  }
  log('depeg', JSON.stringify(results.depeg, null, 1).slice(0, 4000))

  // ---- E3 rsETH loops: market-priced vs exchange-rate-priced venue
  const loopRows: Record<string, unknown>[] = []
  for (const basis of ['market', 'exchangeRate'] as const) {
    for (const hf0 of [1.05, 1.1, 1.25]) {
      for (const [name, cfg] of [
        ['default', DEFAULT_ALERT_CONFIG],
        ['HF tiers only', { ...OFF, healthFactor: DEFAULT_ALERT_CONFIG.healthFactor }],
      ] as const) {
        const r = replay(rsLoopSteps(basis, hf0), cfg)
        const sc = scoreReplay(r, { minLevel: 2, horizonS: 72 * H })
        const first = (rule: string) => r.messages.find((m) => m.ruleId === rule && m.to >= 2)
        loopRows.push({
          basis,
          hf0,
          config: name,
          liquidatedAt: r.liquidatedAt === null ? null : iso(r.liquidatedAt),
          leadWarnPlusH: sc.leadS === null ? null : round(sc.leadS / H, 2),
          leadRule: sc.leadRule,
          missed: sc.missed,
          firstDepegWarn: first('collateral-depeg') ? iso(first('collateral-depeg')!.ts) : null,
          firstHfWarn: first('health-factor') ? iso(first('health-factor')!.ts) : null,
          messages: r.messages.length,
          minMarketHf: round(
            Math.min(
              ...rsRatio.map(([, ratio]) => (((hf0 * 100) / (rsRate * 0.93)) * ratio * 0.93) / 100),
            ),
            3,
          ),
        })
      }
    }
  }
  results.e3RsEthLoops = {
    note: 'rsETH collateral / ETH debt, LT 0.93, opened at the pre-incident rate; hourly DefiLlama ratio; warn+ lead to the first market-oracle liquidation',
    rows: loopRows,
  }
  console.log('\n== E3 rsETH loops')
  for (const r of loopRows) console.log(JSON.stringify(r))

  // ---- E3 exit capacity: Aave USDe cash vs a fixed recall need
  const cash = e3.usdeAaveCash.points as [number, number, number][]
  const capacityRun = (needUsd: number) => {
    // a position whose recall need under the rule's shock is exactly needUsd: ETH collateral
    // at a fixed price, debt sized so recallNeededUsd(s, 0.2, 1.1) = needUsd
    const lt = 0.83
    const price = 1
    const amount = 1_000_000_000
    const weightedShocked = amount * price * 0.8 * lt
    const debt = needUsd + weightedShocked / 1.1
    let state = initialEngineState()
    const msgs: { ts: string; severity: string; transition: string; cover: number }[] = []
    let firstShort: number | null = null
    for (const [ts, , usd] of cash) {
      const s: PositionSnapshot = {
        id: `recall-${needUsd}`,
        ts,
        venue: 'Membrane (modelled)',
        collateral: [{ symbol: 'ETH', amount, oraclePriceUsd: price, liquidationThreshold: lt }],
        debt: [{ symbol: 'USD', amount: debt, priceUsd: 1 }],
      }
      const r = evaluate(
        s,
        {
          capacity: [
            { venue: 'aave-usde', availableUsd: usd, asOf: ts, provenance: 'archive read' },
          ],
        },
        state,
        {
          ...OFF,
          exitCapacity: DEFAULT_ALERT_CONFIG.exitCapacity,
        },
      )
      state = r.state
      if (firstShort === null && usd < needUsd) firstShort = ts
      for (const a of r.alerts.filter((a) => isNotifiable(a)))
        msgs.push({
          ts: iso(ts),
          severity: a.severity,
          transition: a.transition,
          cover: round(a.value, 2) as number,
        })
    }
    const firstWarn = msgs.find((m) => m.severity !== 'watch')
    return {
      needUsd,
      firstShort: firstShort === null ? null : iso(firstShort),
      messages: msgs,
      warnLeadH:
        firstShort !== null && firstWarn
          ? round((firstShort - Date.parse(firstWarn.ts.replace(' ', 'T') + ':00Z') / 1000) / H, 2)
          : null,
    }
  }
  results.e3ExitCapacity = {
    note: 'n = 1 episode. Aave V3 USDe cash (USDe.balanceOf(aEthUSDe)) every ~15 min, Apr 10 → Apr 23 2026. Shows timing only; not a validated rate.',
    runs: [10e6, 50e6, 100e6, 250e6].map(capacityRun),
  }
  log('e3 capacity', JSON.stringify(results.e3ExitCapacity).slice(0, 2000))

  // ---- dry-run Telegram messages. The real replay (E2's largest position) stays internal.
  // The public copy shows a synthetic $100k cbBTC/USDC position held untouched on the real
  // Nov 2025 BTC 1m path, opened at the high before the window low (board rule N18).
  const big = [...e2Prepared].sort(
    (a, b) => b.hist[b.hist.length - 1].borrow - a.hist[a.hist.length - 1].borrow,
  )[0]
  results.sampleMessage = firstPushedMessage(e2Steps(big))
  const btc = E2_SPOT.BTC
  let lowIdx = -1
  btc.close.forEach((c, i) => {
    if (c !== null && (lowIdx < 0 || c < (btc.close[lowIdx] as number))) lowIdx = i
  })
  let highIdx = 0
  for (let i = 0; i < lowIdx; i++) {
    const c = btc.close[i]
    if (c !== null && c > ((btc.close[highIdx] ?? 0) as number)) highIdx = i
  }
  const high = btc.close[highIdx] as number
  const hf0 = Math.max(1.12, (1.02 * high) / (btc.close[lowIdx] as number))
  results.sampleMessageSynthetic = firstPushedMessage(
    setAndForgetSteps({
      id: SYNTHETIC_ID,
      venue: 'Morpho cbBTC/USDC (synthetic)',
      symbol: 'cbBTC',
      amount: amountForHf(hf0, 100_000, high, 0.86),
      debtUsd: 100_000,
      liquidationThreshold: 0.86,
      grid: btc,
      startIdx: highIdx,
      endIdx: lowIdx,
    }),
  )
  if (results.sampleMessageSynthetic)
    console.log('\n== sample dry-run message (public)\n' + results.sampleMessageSynthetic.text)

  writeFileSync(join(DATA, 'backtest-results.json'), JSON.stringify(results, null, 1) + '\n')
  log(`wrote ${join(DATA, 'backtest-results.json')} (internal)`)
  writeFileSync(PUBLIC_RESULTS, JSON.stringify(publicCopy(results), null, 1) + '\n')
  log(`wrote ${PUBLIC_RESULTS} (public, no wallet identifiers)`)
}

main()
