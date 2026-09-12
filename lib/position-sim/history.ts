/**
 * THE SECONDARY PROOF — the wallet's OWN liquidation history, replayed against the
 * Membrane delay infrastructure.
 *
 * Owner brief 2026-09-12: "the amount of liquidations this position would've been
 * saved from, from position creation to now, due to the delay infra." The primary
 * proof (the Oct 10 window) is a counterfactual about a day the wallet may not even
 * have been open for. This one is about events that ACTUALLY HAPPENED to this address.
 *
 * THREE RULES, ALL FROM THE BRIEF, ALL LOAD-BEARING:
 *
 *  1. A DOLLAR FIGURE, NOT A COUNT. "$41,200 in collateral that would still be yours."
 *     The count is the secondary label. This module therefore returns USD on every
 *     branch and never returns a bare verdict.
 *
 *  2. "SAVED" IS DEFINED AGAINST ACTUAL EVENTS. The caller supplies real, decoded
 *     liquidation events and the collateral's real oracle rounds for the 8 hours that
 *     followed. Nothing here manufactures a near-miss: with no rounds the verdict is
 *     'unknown' and the event is never counted in either direction.
 *
 *  3. THE NON-SAVES ARE REPORTED. 'broke' (the position climbed past the 4% band and
 *     Membrane sold immediately) and 'partial' (the window ran out and Membrane repaid
 *     to the borrow cap) both come back with a Membrane seize size, so the UI can say
 *     "liquidated anyway, but 30% of the position instead of 100%". Reporting the
 *     losses is what makes the saves believable.
 *
 * WHAT IS MODELLED HERE (say it on screen, do not bury it):
 *   - LTV over the window is `ltvAtEvent × p0 / p(t)`. Debt is held FIXED across the
 *     8 hours (no accrual, no repay, no top-up) and the collateral is repriced by the
 *     oracle. That is the same debt-fixed convention the Oct 10 engine uses.
 *   - The position is SIZED OFF THE EVENT ITSELF: debt = the USD the liquidator
 *     actually repaid, collateral = that debt divided by the LTV at the event. So
 *     "30% instead of 100%" means 30% of the slice the liquidator actually closed —
 *     not 30% of a total account balance we cannot read at a historical block.
 *   - Membrane's seize is its partial repay-to-cap size (LiquidationEngine.sol
 *     :2204-2238) grossed up by the liquidation fee, and is never allowed to exceed
 *     what the real liquidator took.
 */

import { MAX_LIQ_FEE } from './compare'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  MAX_THRESHOLD_TO_DELAY,
  membraneRepayValue,
} from './membrane'

/** One decoded, real liquidation. Every field is observed or reconstructed by the
 *  caller — this module invents none of them. */
export interface HistoricLiquidation {
  /** Unix seconds of the block the liquidation landed in. */
  ts: number
  /** USD value of the collateral the liquidator seized, bonus included. */
  collateralSeizedUsd: number
  /** USD value of the debt the liquidator repaid. */
  debtRepaidUsd: number
  /** The account's LTV at the moment it was liquidated. By definition it was at or
   *  over its line, so the caller passes `liqLine` unless it can read better. */
  ltvAtEvent: number
  /** The liquidation threshold that was crossed, 0-1. */
  liqLine: number
}

/** One oracle round for the collateral asset. `ts` is the round's own updatedAt. */
export interface PriceRound {
  ts: number
  price: number
}

export interface ReplayParams {
  /** 28,800 s. Real: liquidation-engine/src/contract.rs:52. */
  cureWindowSeconds: number
  /** The break band. 4% — max_threshold_to_delay on every deploy-registered asset. */
  band: number
  /** 3pp. `borrow cap = liquidation line − gap`. Real: lib/Constants.sol:30. */
  borrowLtvGap: number
  /** Membrane's liquidation fee on the repay, 0-MAX_LIQ_FEE. Defaults to the 10%
   *  contract ceiling — the LEAST flattering setting, so no save is bought with a
   *  cheaper liquidator than the one that actually took the collateral. */
  liqFee?: number
}

export const DEFAULT_REPLAY_PARAMS: ReplayParams = {
  cureWindowSeconds: CURE_WINDOW_SECONDS,
  band: MAX_THRESHOLD_TO_DELAY,
  borrowLtvGap: BORROW_LTV_GAP,
  liqFee: MAX_LIQ_FEE,
}

export type ReplayVerdict = 'saved' | 'partial' | 'broke' | 'unknown'

export interface ReplayResult {
  verdict: ReplayVerdict
  /** What the real liquidator took. Passed straight through, never recomputed. */
  actualSeizedUsd: number
  /** What Membrane would have taken. 0 on 'saved'. */
  membraneSeizedUsd: number
  /** Unix seconds the price came back inside the borrow cap. 'saved' only. */
  recoveredAt?: number
  /** Unix seconds the position climbed past the break band. 'broke' only. */
  brokeAt?: number
  /** membraneSeizedUsd / actualSeizedUsd, 0-1. null when there is nothing to divide
   *  by — the UI must then print no percentage rather than a made-up one. */
  membraneShare: number | null
  /** One clause, rendered as-is. Never a paragraph. */
  why: string
}

const unknown = (ev: HistoricLiquidation, why: string): ReplayResult => ({
  verdict: 'unknown',
  actualSeizedUsd: ev.collateralSeizedUsd,
  membraneSeizedUsd: 0,
  membraneShare: null,
  why,
})

/**
 * Replay ONE real liquidation against the 8-hour window and the 4% band.
 *
 * @param ev      the decoded event
 * @param prices  the collateral's oracle rounds. Must span the event (at least one
 *                round at or before `ev.ts` to anchor the price) and the window after
 *                it. Order is irrelevant — they are sorted here.
 */
export function replayLiquidation(
  ev: HistoricLiquidation,
  prices: PriceRound[],
  params: ReplayParams = DEFAULT_REPLAY_PARAMS,
): ReplayResult {
  const { cureWindowSeconds, band, borrowLtvGap } = params
  const fee = Math.max(0, Math.min(MAX_LIQ_FEE, params.liqFee ?? MAX_LIQ_FEE))

  if (!(ev.liqLine > 0) || !(ev.ltvAtEvent > 0)) {
    return unknown(ev, 'no liquidation line could be read for this reserve')
  }

  const rounds = (prices ?? [])
    .filter((r) => r && Number.isFinite(r.ts) && Number.isFinite(r.price) && r.price > 0)
    .slice()
    .sort((a, b) => a.ts - b.ts)

  if (rounds.length === 0) return unknown(ev, 'no oracle rounds for this collateral')

  // Anchor price: the last round at or before the event. If the caller only gave us
  // rounds after the event we anchor on the first of them and say so — we do not
  // extrapolate backwards.
  const before = rounds.filter((r) => r.ts <= ev.ts)
  const anchored = before.length > 0
  const p0 = anchored ? before[before.length - 1].price : rounds[0].price

  const windowEnd = ev.ts + cureWindowSeconds
  const inWindow = rounds.filter((r) => r.ts > ev.ts && r.ts <= windowEnd)
  if (inWindow.length === 0) {
    return unknown(ev, 'no oracle rounds inside the 8-hour window after this event')
  }

  const breakLine = ev.liqLine * (1 + band)
  const borrowCap = Math.max(0, ev.liqLine - borrowLtvGap)

  // The position, sized off the event: the liquidator repaid `debtRepaidUsd` against
  // an account sitting at `ltvAtEvent`, so the collateral behind that slice was
  // debt / ltv. Everything below reprices that collateral and holds the debt fixed.
  const debtUsd = Math.max(0, ev.debtRepaidUsd)
  const coll0 = debtUsd / ev.ltvAtEvent

  const membraneSeizeAt = (price: number): number => {
    const collUsd = coll0 * (price / p0)
    const repay = membraneRepayValue(debtUsd, collUsd, borrowCap)
    const seize = repay * (1 + fee)
    // Never more than the real liquidator took, and never more than the collateral.
    return Math.max(0, Math.min(seize, collUsd, ev.collateralSeizedUsd || seize))
  }

  const share = (m: number) =>
    ev.collateralSeizedUsd > 0 ? Math.min(1, m / ev.collateralSeizedUsd) : null

  for (const r of inWindow) {
    const ltv = ev.ltvAtEvent * (p0 / r.price)

    if (ltv > breakLine) {
      const m = membraneSeizeAt(r.price)
      return {
        verdict: 'broke',
        actualSeizedUsd: ev.collateralSeizedUsd,
        membraneSeizedUsd: m,
        brokeAt: r.ts,
        membraneShare: share(m),
        why: `price kept falling — LTV passed the ${(band * 100).toFixed(0)}% break band ${minutesAfter(ev.ts, r.ts)} after the event, so the sale is immediate`,
      }
    }

    if (ltv <= borrowCap) {
      return {
        verdict: 'saved',
        actualSeizedUsd: ev.collateralSeizedUsd,
        membraneSeizedUsd: 0,
        recoveredAt: r.ts,
        membraneShare: 0,
        why: `price was back under the borrow line ${minutesAfter(ev.ts, r.ts)} after the event, inside the 8-hour window — nothing sold`,
      }
    }
  }

  const last = inWindow[inWindow.length - 1]
  const m = membraneSeizeAt(last.price)
  return {
    verdict: 'partial',
    actualSeizedUsd: ev.collateralSeizedUsd,
    membraneSeizedUsd: m,
    membraneShare: share(m),
    why: anchored
      ? 'still over the line when the 8-hour window ran out — Membrane repays only to the borrow cap'
      : 'still over the line when the 8-hour window ran out (price anchored on the first round after the event)',
  }
}

function minutesAfter(from: number, to: number): string {
  const mins = Math.max(0, Math.round((to - from) / 60))
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

// ------------------------------------------------------------------- totals

/** One replayed event, as the API serves it and the UI renders it. */
export interface HistoryEvent {
  ts: number
  protocol: string
  /** Collateral symbol, or the raw address when we could not name it. */
  collateral: string
  actualSeizedUsd: number
  verdict: ReplayVerdict
  membraneSeizedUsd: number
  membraneShare: number | null
  recoveredAt?: number
  brokeAt?: number
  why: string
}

export interface HistoryTotals {
  /** Collateral that would still be yours: the seizes Membrane avoided entirely. */
  savedUsd: number
  savedCount: number
  /** Collateral Membrane would still have kept on the events it could NOT save. */
  partialUsd: number
  partialCount: number
  brokeCount: number
  unpricedCount: number
}

export const ZERO_TOTALS: HistoryTotals = {
  savedUsd: 0,
  savedCount: 0,
  partialUsd: 0,
  partialCount: 0,
  brokeCount: 0,
  unpricedCount: 0,
}

/** Sum the replayed events. 'unknown' contributes to `unpricedCount` and to NOTHING
 *  else — an event we could not price is never counted as a save or as a loss. */
export function totalHistory(events: HistoryEvent[]): HistoryTotals {
  const t: HistoryTotals = { ...ZERO_TOTALS }
  for (const e of events) {
    if (e.verdict === 'saved') {
      t.savedUsd += e.actualSeizedUsd
      t.savedCount += 1
    } else if (e.verdict === 'partial') {
      t.partialUsd += Math.max(0, e.actualSeizedUsd - e.membraneSeizedUsd)
      t.partialCount += 1
    } else if (e.verdict === 'broke') {
      t.brokeCount += 1
    } else {
      t.unpricedCount += 1
    }
  }
  return t
}

/** The API response shape. Shared by the route, the UI and the offline script. */
export interface HistoryResponse {
  address: string
  since: { firstEventTs: number | null }
  events: HistoryEvent[]
  totals: HistoryTotals
  /** How this was measured, verbatim. Rendered as one fine-print bullet. */
  method: string
  provenance: 'observed' | 'modelled'
  scannedAt: string
  /** The head block the scan reached, as a decimal string (JSON has no bigint). Stored
   *  on the cache row so a later incremental scan knows where this one stopped. */
  scannedToBlock?: string
  /** Protocols this scan did NOT cover. Named on screen, never silently omitted. */
  notScanned?: string[]
  /** Present only when the scan itself failed. The UI prints it and shows no number. */
  error?: string
}
