/**
 * The reverse solve, written as actions (DESIGN_RULES §7; FORECAST_VISUALS.md "Move your
 * line"): "Repay 4,810 USDC · line −Y% · Z% (lo–hi)", "Add 0.29 WETH · …".
 *
 * On the SAME model and the SELECTED horizon as the forecast above it: for each target Z
 * of the horizon's point forecast, find the smallest table level L* whose forecast is at
 * or below Z, then the repay (or top-up) that moves the line to L*. Amounts are solved in
 * the TOKEN's own units and round UP (10 for a USD stable, 0.01 ETH-family, 0.0001
 * BTC-family, otherwise a step worth ≥ $10), then grow until the line still holds after
 * ACCRUAL_BUFFER_HOURS of interest. Every row prints the TOKEN amount the reader sends —
 * never a dollar figure, which at a $0.9999 oracle price would fall short of the line. Y is
 * the floor of the distance the rounded amount reaches AFTER the buffer's interest (≥ L*),
 * and Z' (with its band) is the forecast at Y. Every amount comes from the live position;
 * nothing here is a constant except the targets and the buffer.
 *
 * Closed forms (B = W − D; E = Wm − Dm for a fall, Dm − Wm for a rise; see liquidation.ts):
 *   repay a held debt X        x' = (B + X) / E            X = L·E − B
 *   repay a moving debt X      fall  x' = (B + X)/(E + X)   X = (L·E − B)/(1 − L)
 *                              rise  x' = (B + X)/(E − X)   X = (L·E − B)/(1 + L)
 *   add moving collateral a    fall  x' = (B + a)/(E + a)   a = (L·E − B)/(1 − L)
 *   add held collateral a      x' = (B + a) / E            a = L·E − B
 * where a is weighted value (amount · price · LT).
 */

import type { PositionSnapshot } from '@/lib/positionAlerts/types'

import { amountStepFor, ceilTo, fmtAmount, fmtMove, stepDecimals } from './format'
import { lineDistance, type LineModel } from './liquidation'
import { historyAssetFor, isUsdStable } from './snapshot'
import { atOrBelow, floorPct, formatBand, formatChance, touchAtLevel, type TouchFrequency } from './touch'
import type { Direction, HistoryAsset, HorizonId, TouchTable } from './touchHistory'

/** The horizon the page opens on; the reader's tab choice replaces it. */
export const DEFAULT_HORIZON: HorizonId = '7d'
/** Point forecasts (at the selected horizon) the rows solve for, in percent. */
export const REVERSE_SOLVE_TARGETS_PCT = [10, 5, 1] as const
/** A USD-stable repay rounds up to this many tokens (FAMILY steps cover ETH and BTC). */
export const REPAY_ROUND_USD = 10

export interface ActionRow {
  kind: 'repay' | 'add'
  /** The target this row was solved for, in percent of the selected horizon's forecast. */
  targetPct: number
  /** L*: the smallest table level at or below the target. */
  level: number
  /** Asset repaid or added. */
  symbol: string
  /** Units of `symbol` to repay or add, rounded up. */
  amount: number
  amountDecimals: number
  /** Today's dollar value of `amount`. */
  amountUsd: number
  direction: Direction
  /** Y: the floored distance the rounded amount reaches after the accrual buffer. */
  newDistancePct: number
  horizon: HorizonId
  /** Z' and its band: the forecast at Y, at the selected horizon. */
  history: TouchFrequency
  /** "Repay 480 USDC · line −22% · 5% (3–7%)" */
  text: string
  /** The curve's dot label: "Repay 480 USDC → 5%" */
  short: string
}

/** Smallest level whose `horizon` frequency is at or below `targetPct`, or null. */
export function levelForTarget(
  t: TouchTable,
  asset: HistoryAsset,
  direction: Direction,
  horizon: HorizonId,
  targetPct: number,
): number | null {
  const r = t.assets[asset][direction][horizon]
  for (let L = t.levels.min; L <= t.levels.max; L++) {
    if (atOrBelow(r.touched[L - t.levels.min], r.n, targetPct)) return L
  }
  return null
}

const exposure = (m: Pick<LineModel, 'direction' | 'Wm' | 'Dm'>) =>
  m.direction === 'fall' ? m.Wm - m.Dm : m.Dm - m.Wm

/** Dollars of debt to repay so the line sits at fraction L. ≤ 0 when already there. */
export function repayFor(m: LineModel, L: number, moving: boolean): number {
  const B = m.W - m.D
  const E = exposure(m)
  if (!moving) return L * E - B
  return m.direction === 'fall' ? (L * E - B) / (1 - L) : (L * E - B) / (1 + L)
}

/** The model after repaying X dollars of a held or moving debt leg. */
export function afterRepay(m: LineModel, X: number, moving: boolean): LineModel {
  return { ...m, D: m.D - X, Dm: moving ? m.Dm - X : m.Dm }
}

/** Weighted collateral (amount · price · LT) to add so the line sits at L. */
export function addFor(m: LineModel, L: number, moving: boolean): number {
  const B = m.W - m.D
  const E = exposure(m)
  if (!moving) return L * E - B
  if (m.direction !== 'fall') throw new Error('addFor: moving collateral only exists for a fall risk')
  return (L * E - B) / (1 - L)
}

export function afterAdd(m: LineModel, a: number, moving: boolean): LineModel {
  return { ...m, W: m.W + a, Wm: moving ? m.Wm + a : m.Wm }
}

interface Leg {
  symbol: string
  amount: number
  priceUsd: number
  lt: number
}

/** The debt leg a repay row pays down: the quoted leg for a rise risk, else the largest. */
function repayLeg(s: PositionSnapshot, m: LineModel): (Leg & { moving: boolean }) | null {
  const debt = s.debt.filter((d) => d.amount > 0)
  if (debt.length === 0) return null
  const pick =
    (m.direction === 'rise' ? debt.find((d) => d.symbol === m.symbol) : undefined) ??
    [...debt].sort((a, b) => b.amount * b.priceUsd - a.amount * a.priceUsd)[0]
  return { symbol: pick.symbol, amount: pick.amount, priceUsd: pick.priceUsd, lt: 0, moving: m.moving.includes(pick.symbol) }
}

/** The collateral leg a top-up row adds: the quoted leg for a fall risk, else the largest. */
function addLeg(s: PositionSnapshot, m: LineModel): (Leg & { moving: boolean }) | null {
  const coll = s.collateral.filter((c) => c.amount > 0 && c.liquidationThreshold > 0)
  if (coll.length === 0) return null
  const pick =
    (m.direction === 'fall' ? coll.find((c) => c.symbol === m.symbol) : undefined) ??
    [...coll].sort((a, b) => b.amount * b.oraclePriceUsd - a.amount * a.oraclePriceUsd)[0]
  return {
    symbol: pick.symbol,
    amount: pick.amount,
    priceUsd: pick.oraclePriceUsd,
    lt: pick.liquidationThreshold,
    moving: m.moving.includes(pick.symbol),
  }
}

/**
 * ACCRUAL BUFFER. A row must still hold when the reader acts, not only at read time: debt
 * keeps accruing. Every amount is solved so the line stays at or past L* after this many
 * hours of interest on ALL debt, at the highest borrow APR the read reports (or
 * FALLBACK_BORROW_APR where a venue's rate was not read, e.g. Morpho).
 */
export const ACCRUAL_BUFFER_HOURS = 24
export const FALLBACK_BORROW_APR = 0.25

/**
 * The rounding step for an amount of `symbol`: 10 tokens for a USD stable (a $0.9999 stable
 * must not round to 100s), the family step for ETH and BTC, else a step worth ≥ $10.
 */
export function unitStep(symbol: string, priceUsd: number): number {
  if (isUsdStable(symbol)) return REPAY_ROUND_USD
  return amountStepFor(historyAssetFor(symbol), priceUsd)
}

/**
 * Why a solve has no rows (FORECAST_VISUALS.md "Move your line" says which):
 *   met           every target is already met at the reader's line
 *   beyond        no table level gets under a target
 *   beyond-table  a lever exists, but even its smallest step moves the line past the
 *                 table's last level, where no forecast is read (a small position)
 *   no-lever      no repay or top-up of this position reaches the level
 */
export type SolveReason = 'ok' | 'met' | 'beyond' | 'beyond-table' | 'no-lever' | 'no-debt'

export interface ReverseSolve {
  rows: ActionRow[]
  reason: SolveReason
  /** Targets already met at the reader's line, and targets no table level reaches. */
  met: number[]
  beyond: number[]
  /** Levers whose solved amount landed past the table's last level ('beyond-table'). */
  pastTable: ActionRow['kind'][]
}

/** Interest growth over the buffer at `apr` (null → the fallback). */
export const accrualFactor = (apr: number | null): number =>
  1 + (apr !== null && apr >= 0 ? apr : FALLBACK_BORROW_APR) * (ACCRUAL_BUFFER_HOURS / 8760)

/** The action rows for one position, and why there are none when there are none. */
export function reverseSolve(
  s: PositionSnapshot,
  m: LineModel,
  t: TouchTable,
  asset: HistoryAsset,
  horizon: HorizonId = DEFAULT_HORIZON,
  borrowApr: number | null = null,
): ReverseSolve {
  if (!(m.D > 0)) return { rows: [], reason: 'no-debt', met: [], beyond: [], pastTable: [] }
  const now = lineDistance(m)
  const g = accrualFactor(borrowApr)
  const accrued = (mm: LineModel): LineModel => ({ ...mm, D: mm.D * g, Dm: mm.Dm * g })
  const rows: ActionRow[] = []
  const seen = new Set<string>()
  const met: number[] = []
  const beyond: number[] = []
  const pastTable = new Set<ActionRow['kind']>()
  const rLeg = repayLeg(s, m)
  const aLeg = addLeg(s, m)

  const push = (row: Omit<ActionRow, 'history' | 'text' | 'short' | 'horizon'> & { history: TouchFrequency | null }) => {
    // Past the table's last level there is no forecast to print: say so, not "no lever".
    if (!row.history) {
      pastTable.add(row.kind)
      return
    }
    const key = `${row.kind}:${row.newDistancePct}`
    if (seen.has(key)) return
    seen.add(key)
    const h = row.history
    const chance = formatChance(h.touched, h.n)
    // The token amount is the action: a stable at $0.9999 repaid as "$X" would fall short.
    const what = `${row.kind === 'repay' ? 'Repay' : 'Add'} ${fmtAmount(row.amount, row.amountDecimals)} ${row.symbol}`
    rows.push({
      ...row,
      horizon,
      history: h,
      text: `${what} · line ${fmtMove(row.newDistancePct, row.direction)} · ${chance} (${formatBand(h.lo, h.hi, h.n)})`,
      short: `${what} → ${chance}`,
    })
  }

  /** Smallest multiple of `step` from `start` whose result still holds after accrual. */
  const settle = (start: number, step: number, apply: (units: number) => LineModel, L: number, max: number) => {
    let units = start
    for (let i = 0; i < 10_000 && units <= max; i++) {
      if (lineDistance(accrued(apply(units))) >= L - 1e-12) return units
      units = ceilTo(units + step, step)
    }
    return null
  }

  for (const targetPct of REVERSE_SOLVE_TARGETS_PCT) {
    const level = levelForTarget(t, asset, m.direction, horizon, targetPct)
    if (level === null) {
      beyond.push(targetPct) // no level in the table reaches this target
      continue
    }
    const L = level / 100
    if (now >= L) {
      met.push(targetPct) // already at or past the target level: a no-op row
      continue
    }

    // --- repay, in the debt token's own units ------------------------------------
    if (rLeg) {
      const exact = repayFor(m, L, rLeg.moving)
      if (exact > 0) {
        const step = unitStep(rLeg.symbol, rLeg.priceUsd)
        const apply = (units: number) => afterRepay(m, units * rLeg.priceUsd, rLeg.moving)
        // Repaying all of the leg is not a lever: it leaves no line to move.
        const units = settle(ceilTo(exact / rLeg.priceUsd, step), step, apply, L, rLeg.amount - step)
        if (units !== null && units < rLeg.amount) {
          const Y = floorPct(lineDistance(accrued(apply(units))))
          push({
            kind: 'repay',
            targetPct,
            level,
            symbol: rLeg.symbol,
            amount: units,
            amountDecimals: stepDecimals(step),
            amountUsd: units * rLeg.priceUsd,
            direction: m.direction,
            newDistancePct: Y,
            history: touchAtLevel(t, asset, m.direction, horizon, Y),
          })
        }
      }
    }

    // --- add collateral, in the collateral token's own units ----------------------
    if (aLeg && (aLeg.moving ? m.direction === 'fall' : true)) {
      const weighted = addFor(m, L, aLeg.moving)
      if (weighted > 0) {
        const step = unitStep(aLeg.symbol, aLeg.priceUsd)
        const apply = (units: number) => afterAdd(m, units * aLeg.priceUsd * aLeg.lt, aLeg.moving)
        const units = settle(ceilTo(weighted / (aLeg.lt * aLeg.priceUsd), step), step, apply, L, Number.POSITIVE_INFINITY)
        if (units !== null) {
          const Y = floorPct(lineDistance(accrued(apply(units))))
          push({
            kind: 'add',
            targetPct,
            level,
            symbol: aLeg.symbol,
            amount: units,
            amountDecimals: stepDecimals(step),
            amountUsd: units * aLeg.priceUsd,
            direction: m.direction,
            newDistancePct: Y,
            history: touchAtLevel(t, asset, m.direction, horizon, Y),
          })
        }
      }
    }
  }
  // Repay rows first, then top-ups, each nearest-first: one lever per line.
  const ordered = [...rows.filter((r) => r.kind === 'repay'), ...rows.filter((r) => r.kind === 'add')]
  const reason: SolveReason =
    ordered.length > 0
      ? 'ok'
      : pastTable.size > 0
        ? 'beyond-table'
        : beyond.length > 0
          ? 'beyond'
          : met.length === REVERSE_SOLVE_TARGETS_PCT.length
            ? 'met'
            : 'no-lever'
  return { rows: ordered, reason, met, beyond, pastTable: [...pastTable] }
}
