/**
 * Back-test core: replay a position over a price path through the real engine, then score
 * what the borrower would have received. Pure — the harness
 * (scripts/research/position-alert-backtest.ts) does the file reads and the sweeps.
 *
 * Definitions (the memo quotes these verbatim):
 *   liquidation   first step whose intra-step worst health factor is < 1. Its time is the
 *                 START of that step — the earliest the liquidation could have happened,
 *                 so lead times are never flattered by a coarse grid.
 *   episode       for one rule key, the time from the first MESSAGE that took it to
 *                 >= minLevel until its level next dropped below minLevel.
 *   lead time     liquidation time − start of the earliest episode still open at
 *                 liquidation. No open episode = MISSED.
 *   censored      that episode was already open at the first evaluated sample, so the
 *                 lead time is a lower bound.
 *   false alarm   a worsening message at >= minLevel with no liquidation in the following
 *                 horizonS. Messages whose horizon runs past the end of the data are
 *                 UNDECIDED and counted separately.
 */

import type { AlertConfig } from './config'
import { evaluate, initialEngineState, isNotifiable } from './engine'
import type { Alert, Level, MarketContext, PositionSnapshot } from './types'
import { levelOf } from './types'

export interface ReplayStep {
  /** When the monitor reads this sample (the END of the step). */
  ts: number
  /** Start of the interval this step covers. Liquidation inside it is stamped here. */
  intervalStart: number
  /** What the monitor sees. null = no data this step. */
  snapshot: PositionSnapshot | null
  ctx?: MarketContext
  /** Lowest health factor reached inside the interval. null = unknown, no liquidation check. */
  worstHf: number | null
}

export interface ReplayOptions {
  /** Seconds between monitor reads. Steps in between still count for liquidation. */
  monitorEveryS?: number
  /** Stop at the first liquidation (set-and-forget: the position no longer exists as was). */
  stopAtLiquidation?: boolean
  /** Use this instead of the modelled liquidation (a real, observed liquidation time). */
  knownLiquidationTs?: number | null
}

export interface ReplayResult {
  /** Every transition, silent ones included. */
  alerts: Alert[]
  /** The ones a borrower would have received. */
  messages: Alert[]
  liquidatedAt: number | null
  /** First modelled health factor < 1 (kept even when a known liquidation time is supplied). */
  modelledLiquidationAt: number | null
  minHf: number
  firstEvalTs: number | null
  lastTs: number | null
  evaluations: number
}

export function replay(
  steps: Iterable<ReplayStep>,
  config: AlertConfig,
  opts: ReplayOptions = {},
): ReplayResult {
  const every = opts.monitorEveryS ?? 0
  const stop = opts.stopAtLiquidation ?? true
  const known = opts.knownLiquidationTs ?? null
  let state = initialEngineState()
  const alerts: Alert[] = []
  let modelled: number | null = null
  let minHf = Infinity
  let lastEval = -Infinity
  let firstEvalTs: number | null = null
  let lastTs: number | null = null
  let evaluations = 0

  for (const s of steps) {
    if (known !== null && s.intervalStart >= known) break
    lastTs = s.ts
    if (s.worstHf !== null) {
      minHf = Math.min(minHf, s.worstHf)
      if (s.worstHf < 1 && modelled === null) {
        modelled = s.intervalStart
        if (stop && known === null) break
      }
    }
    if (!s.snapshot || s.ts - lastEval < every) continue
    const r = evaluate(s.snapshot, s.ctx ?? {}, state, config)
    state = r.state
    lastEval = s.ts
    evaluations++
    if (firstEvalTs === null) firstEvalTs = s.ts
    if (Number.isFinite(r.metrics.healthFactor)) minHf = Math.min(minHf, r.metrics.healthFactor)
    alerts.push(...r.alerts)
  }
  return {
    alerts,
    messages: alerts.filter((a) => isNotifiable(a)),
    liquidatedAt: known ?? modelled,
    modelledLiquidationAt: modelled,
    minHf,
    firstEvalTs,
    lastTs,
    evaluations,
  }
}

export interface ScoreOptions {
  minLevel: Level
  horizonS: number
  /** Only count these rules (default: all). */
  rules?: string[]
}

export interface Score {
  liquidated: boolean
  leadS: number | null
  missed: boolean
  censored: boolean
  /** Rule that opened the earliest still-open episode. */
  leadRule: string | null
  /** Worsening messages at >= minLevel. */
  worsening: number
  falseAlarms: number
  trueAlarms: number
  undecided: number
  /** All notifiable messages (any level, clears included). */
  messages: number
}

export function scoreReplay(r: ReplayResult, o: ScoreOptions): Score {
  const inScope = (a: Alert) => !o.rules || o.rules.includes(a.ruleId)
  const level = new Map<string, Level>()
  const openSince = new Map<string, number>()
  for (const a of r.alerts) {
    if (!inScope(a)) continue
    const id = `${a.ruleId}:${a.key}`
    const before = level.get(id) ?? 0
    level.set(id, a.to)
    if (a.to < o.minLevel) openSince.delete(id)
    else if (before < o.minLevel && a.transition !== 'ease' && a.transition !== 'clear')
      openSince.set(id, a.ts)
  }

  let leadS: number | null = null
  let leadRule: string | null = null
  let censored = false
  if (r.liquidatedAt !== null) {
    let earliest = Infinity
    for (const [id, t] of openSince) {
      if (t < earliest && t <= r.liquidatedAt) {
        earliest = t
        leadRule = id.split(':')[0]
      }
    }
    if (Number.isFinite(earliest)) {
      leadS = r.liquidatedAt - earliest
      censored = earliest === r.firstEvalTs
    }
  }

  let falseAlarms = 0
  let trueAlarms = 0
  let undecided = 0
  let worsening = 0
  for (const a of r.messages) {
    if (
      !inScope(a) ||
      (a.transition !== 'fire' && a.transition !== 'escalate') ||
      levelOf(a.severity) < o.minLevel
    )
      continue
    worsening++
    if (r.liquidatedAt !== null && r.liquidatedAt > a.ts && r.liquidatedAt <= a.ts + o.horizonS)
      trueAlarms++
    else if (r.liquidatedAt === null && (r.lastTs === null || a.ts + o.horizonS > r.lastTs))
      undecided++
    else falseAlarms++
  }

  return {
    liquidated: r.liquidatedAt !== null,
    leadS,
    missed: r.liquidatedAt !== null && leadS === null,
    censored,
    leadRule,
    worsening,
    falseAlarms,
    trueAlarms,
    undecided,
    messages: r.messages.filter(inScope).length,
  }
}

// ------------------------------------------------------------------ path helpers

export interface PriceGrid {
  startTs: number
  stepS: number
  close: ReadonlyArray<number | null>
  /** Intra-step lows. Defaults to close. */
  low?: ReadonlyArray<number | null>
}

/**
 * Trailing volatility of 1h log returns at each index, EWMA with the given half-life.
 * Lookahead-free: index i uses returns up to and including i. NaN until `warmupH` hours.
 */
export function ewmaHourlyVol(grid: PriceGrid, halfLifeH: number, warmupH = 24): Float64Array {
  const n = grid.close.length
  const out = new Float64Array(n).fill(NaN)
  const stepsPerH = 3600 / grid.stepS
  const lambda = Math.pow(0.5, 1 / (halfLifeH * stepsPerH))
  let v = NaN
  let prev: number | null = null
  let seen = 0
  for (let i = 0; i < n; i++) {
    const p = grid.close[i]
    if (p !== null && p > 0 && prev !== null) {
      const r = Math.log(p / prev)
      v = Number.isNaN(v) ? r * r : lambda * v + (1 - lambda) * r * r
      seen++
    }
    if (p !== null && p > 0) prev = p
    if (seen >= warmupH * stepsPerH) out[i] = Math.sqrt(v * stepsPerH)
  }
  return out
}

/** Collateral amount that opens a single-collateral position at health factor hf0. */
export const amountForHf = (hf0: number, debtUsd: number, price: number, lt: number): number =>
  (hf0 * debtUsd) / (price * lt)

export interface SetAndForget {
  id: string
  venue: string
  symbol: string
  amount: number
  debtUsd: number
  liquidationThreshold: number
  grid: PriceGrid
  /** Grid index the position opens at (its close is the opening price). */
  startIdx: number
  /** Last grid index replayed (inclusive). */
  endIdx: number
  vol?: Float64Array
}

/**
 * One single-collateral, stable-debt position held untouched over a grid. Step i covers
 * bar i: the monitor reads its close at the bar end; liquidation checks its low.
 */
export function* setAndForgetSteps(p: SetAndForget): Generator<ReplayStep> {
  const { grid } = p
  const lows = grid.low ?? grid.close
  const weighted = p.amount * p.liquidationThreshold
  for (let i = p.startIdx + 1; i <= p.endIdx; i++) {
    const close = grid.close[i]
    const low = lows[i] ?? close
    const t0 = grid.startTs + i * grid.stepS
    const sigma = p.vol?.[i]
    yield {
      ts: t0 + grid.stepS,
      intervalStart: t0,
      worstHf: low === null ? null : (weighted * low) / p.debtUsd,
      snapshot:
        close === null
          ? null
          : {
              id: p.id,
              ts: t0 + grid.stepS,
              venue: p.venue,
              collateral: [
                {
                  symbol: p.symbol,
                  amount: p.amount,
                  oraclePriceUsd: close,
                  liquidationThreshold: p.liquidationThreshold,
                },
              ],
              debt: [{ symbol: 'USD', amount: p.debtUsd, priceUsd: 1 }],
            },
      ctx:
        sigma !== undefined && Number.isFinite(sigma) ? { hourlyVol: { [p.symbol]: sigma } } : {},
    }
  }
}

// ------------------------------------------------------------------ summaries

export function quantile(xs: number[], q: number): number | null {
  if (xs.length === 0) return null
  const s = [...xs].sort((a, b) => a - b)
  const pos = (s.length - 1) * q
  const lo = Math.floor(pos)
  const hi = Math.ceil(pos)
  return s[lo] + (s[hi] - s[lo]) * (pos - lo)
}

export interface LeadSummary {
  liquidations: number
  missed: number
  censored: number
  /** Lead times of warned liquidations, seconds. */
  median: number | null
  p10: number | null
  p90: number | null
  /** Share of liquidations warned at least this long before. */
  atLeast15m: number
  atLeast1h: number
  atLeast4h: number
}

export function summariseLeads(scores: Score[]): LeadSummary {
  const liq = scores.filter((s) => s.liquidated)
  const leads = liq.filter((s) => s.leadS !== null).map((s) => s.leadS as number)
  const share = (min: number) =>
    liq.length ? leads.filter((l) => l >= min).length / liq.length : 0
  return {
    liquidations: liq.length,
    missed: liq.filter((s) => s.missed).length,
    censored: liq.filter((s) => s.censored).length,
    median: quantile(leads, 0.5),
    p10: quantile(leads, 0.1),
    p90: quantile(leads, 0.9),
    atLeast15m: share(15 * 60),
    atLeast1h: share(3600),
    atLeast4h: share(4 * 3600),
  }
}
