/**
 * The reverse solve, written as actions (DESIGN_RULES §7; FORECAST_VISUALS.md "Move your
 * line"): "Repay $X · line −Y% · Z% (lo–hi)".
 *
 * On the SAME model and the SELECTED horizon as the forecast above it: for each target Z
 * of the horizon's point forecast, find the smallest table level L* whose forecast is at
 * or below Z, then the repay (or top-up) that moves the line to L*. Amounts round UP
 * (repay to $10; top-up to 0.01 ETH-family, 0.0001 BTC-family, otherwise a step worth
 * ≥ $10), Y is the floor of the distance the ROUNDED amount reaches, and Z' (with its band)
 * is the forecast at Y. Every amount comes from the live position; nothing here is a
 * constant except the targets.
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

import { amountStepFor, ceilTo, fmtAmount, fmtMove, fmtUsd, stepDecimals } from './format'
import { lineDistance, type LineModel } from './liquidation'
import { historyAssetFor } from './snapshot'
import { atOrBelow, floorPct, formatBand, formatChance, touchAtLevel, type TouchFrequency } from './touch'
import type { Direction, HistoryAsset, HorizonId, TouchTable } from './touchHistory'

/** The horizon the page opens on; the reader's tab choice replaces it. */
export const DEFAULT_HORIZON: HorizonId = '7d'
/** Point forecasts (at the selected horizon) the rows solve for, in percent. */
export const REVERSE_SOLVE_TARGETS_PCT = [10, 5, 1] as const
/** Repay amounts round up to this many dollars. */
export const REPAY_ROUND_USD = 10

export interface ActionRow {
  kind: 'repay' | 'add'
  /** The target this row was solved for, in percent of the selected horizon's forecast. */
  targetPct: number
  /** L*: the smallest table level at or below the target. */
  level: number
  /** Asset repaid or added. */
  symbol: string
  /** Repay: dollars. Add: units of `symbol`. Rounded up. */
  amount: number
  amountDecimals: number
  /** Today's dollar value of `amount`. */
  amountUsd: number
  direction: Direction
  /** Y: the floored distance the rounded amount reaches. */
  newDistancePct: number
  horizon: HorizonId
  /** Z' and its band: the forecast at Y, at the selected horizon. */
  history: TouchFrequency
  /** "Repay $480 · line −22% · 5% (3–7%)" */
  text: string
  /** The curve's dot label: "Repay $480 → 5%" */
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
 * The action rows for one position. Empty when there is no debt, no history table for the
 * position, or every target is already met or beyond the table.
 */
export function reverseSolve(
  s: PositionSnapshot,
  m: LineModel,
  t: TouchTable,
  asset: HistoryAsset,
  horizon: HorizonId = DEFAULT_HORIZON,
): ActionRow[] {
  if (!(m.D > 0)) return []
  const now = lineDistance(m)
  const rows: ActionRow[] = []
  const seen = new Set<string>()
  const debtLegs = s.debt.filter((d) => d.amount > 0).length
  const rLeg = repayLeg(s, m)
  const aLeg = addLeg(s, m)

  const push = (row: Omit<ActionRow, 'history' | 'text' | 'short' | 'horizon'> & { history: TouchFrequency | null }) => {
    if (!row.history) return
    const key = `${row.kind}:${row.newDistancePct}`
    if (seen.has(key)) return
    seen.add(key)
    const h = row.history
    const chance = formatChance(h.touched, h.n)
    const what =
      row.kind === 'repay'
        ? `Repay ${fmtUsd(row.amount)}${debtLegs > 1 ? ` of ${row.symbol}` : ''}`
        : `Add ${fmtAmount(row.amount, row.amountDecimals)} ${row.symbol}`
    rows.push({
      ...row,
      horizon,
      history: h,
      text: `${what} · line ${fmtMove(row.newDistancePct, row.direction)} · ${chance} (${formatBand(h.lo, h.hi, h.n)})`,
      short: `${what} → ${chance}`,
    })
  }

  for (const targetPct of REVERSE_SOLVE_TARGETS_PCT) {
    const level = levelForTarget(t, asset, m.direction, horizon, targetPct)
    if (level === null) continue // no level in the table reaches this target
    const L = level / 100
    if (now >= L) continue // already at or past the target level: a no-op row

    // --- repay ---------------------------------------------------------------
    if (rLeg) {
      const exact = repayFor(m, L, rLeg.moving)
      const legUsd = rLeg.amount * rLeg.priceUsd
      const X = ceilTo(exact, REPAY_ROUND_USD)
      if (exact > 0 && X < legUsd) {
        const Y = floorPct(lineDistance(afterRepay(m, X, rLeg.moving)))
        push({
          kind: 'repay',
          targetPct,
          level,
          symbol: rLeg.symbol,
          amount: X,
          amountDecimals: 0,
          amountUsd: X,
          direction: m.direction,
          newDistancePct: Y,
          history: touchAtLevel(t, asset, m.direction, horizon, Y),
        })
      }
    }

    // --- add collateral --------------------------------------------------------
    if (aLeg && (aLeg.moving ? m.direction === 'fall' : true)) {
      const weighted = addFor(m, L, aLeg.moving)
      if (weighted > 0) {
        const step = amountStepFor(historyAssetFor(aLeg.symbol), aLeg.priceUsd)
        const N = ceilTo(weighted / (aLeg.lt * aLeg.priceUsd), step)
        const a = N * aLeg.priceUsd * aLeg.lt
        const Y = floorPct(lineDistance(afterAdd(m, a, aLeg.moving)))
        push({
          kind: 'add',
          targetPct,
          level,
          symbol: aLeg.symbol,
          amount: N,
          amountDecimals: stepDecimals(step),
          amountUsd: N * aLeg.priceUsd,
          direction: m.direction,
          newDistancePct: Y,
          history: touchAtLevel(t, asset, m.direction, horizon, Y),
        })
      }
    }
  }
  // Repay rows first, then top-ups, each nearest-first: one lever per line.
  return [...rows.filter((r) => r.kind === 'repay'), ...rows.filter((r) => r.kind === 'add')]
}
