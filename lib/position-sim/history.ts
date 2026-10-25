/**
 * THE SECONDARY PROOF — the wallet's OWN liquidation history, replayed against the
 * Membrane delay infrastructure.
 *
 * Owner brief 2026-09-12: "the amount of liquidations this position would've been
 * saved from, from position creation to now, due to the delay infra." The primary
 * proof (the Oct 10 window) is a counterfactual about a day the wallet may not even
 * have been open for. This one is about events that ACTUALLY HAPPENED to this address.
 *
 * OWNER RULING 2026-09-12 (the reason this file is an EPISODE replay and not an event
 * replay): "assert that the partial closes take into account the possibility of those
 * positions RE-LIQUIDATING, not just assuming they only liquidate once."
 *
 * A repay-to-cap does not end the story. It leaves a smaller position that is STILL
 * only 3pp under its line, and if the price keeps falling that position crosses again,
 * arms a NEW 8-hour timer, and gets hit again. Charging Membrane one partial per real
 * event flatters it. So the unit of replay is an EPISODE — every real event within 24h
 * of the previous one — and the Membrane side is a CHAIN of seizures walked over the
 * 72 hours after the episode's last event.
 *
 * FOUR RULES, ALL FROM THE BRIEF, ALL LOAD-BEARING:
 *
 *  1. A DOLLAR FIGURE, NOT A COUNT. "$41,200 in collateral that would still be yours."
 *     The count is the secondary label. Every branch returns USD.
 *
 *  2. "SAVED" IS DEFINED AGAINST ACTUAL EVENTS. The caller supplies real, decoded
 *     liquidation events and the collateral's real oracle rounds. Nothing here
 *     manufactures a near-miss: with no rounds the verdict is 'unknown' and the episode
 *     is never counted in either direction.
 *
 *  3. THE NON-SAVES ARE REPORTED. 'partial' (the window ran out, >=1 repay-to-cap),
 *     'broke' (the position climbed past the 4% band and Membrane sold immediately) and
 *     'worse' (the CHAIN cost more than the real liquidator did) all come back with a
 *     Membrane seize size and a liquidation COUNT. Reporting the losses is what makes
 *     the saves believable, and 'worse' is printed, never hidden.
 *
 *  4. THE CHAIN IS NEVER CAPPED AT THE REAL SEIZE. The old single-event replay clamped
 *     Membrane's seize to what the real liquidator took, which made 'worse'
 *     arithmetically impossible. That clamp is gone.
 *
 * WHAT IS MODELLED HERE (say it on screen, do not bury it):
 *   - The episode starts at the FIRST event's timestamp with the position AT its line
 *     (ltv = liqLine). Debt is the USD the liquidators actually repaid across the
 *     episode and is held FIXED except where Membrane repays it; the collateral is
 *     repriced by the anchor collateral's oracle rounds. Same debt-fixed convention the
 *     Oct 10 engine uses.
 *   - Crossing the line ARMS an 8h timer. Inside the window: over line x (1+band) is a
 *     BROKE seizure at that price; back under the LINE cures it and clears the timer.
 *     The window expiring still at or over the line is a PARTIAL seizure at the price
 *     prevailing AT EXPIRY. A position at or under its line is not liquidatable on
 *     master (`CdpInternal.insolvent` is `ratio > avgMaxLTV`, lib/CdpInternal.sol:329);
 *     `Cdp.liquidate` clears its stale timer instead (Cdp.sol:2236-2248, LE:926-946).
 *     (Changed 2026-10-04: this used to cure only at the borrow cap, line − 3pp, and
 *     seized an expired window that sat between the cap and the line — overstating
 *     Membrane's seizures in the wallet-history proof.)
 *     ONE BOUNDARY for arm and cure (owner ruling 2026-10-04: the timer starts and ends
 *     at the LLTV line; back under it is out of the window, "saved"). `overLine` decides
 *     both: it arms a timer, and its negation `underLine` clears one. The boundary is
 *     master's `ratio > line` (lib/CdpInternal.sol:329) with ONE adjustment: the episode
 *     is pinned AT its line at the anchor price, a stand-in for "just over it" — the real
 *     liquidation proves the position was liquidatable there — so an LTV within 1e-12
 *     of the line (equality, or float noise in re-deriving the anchor) counts as OVER it,
 *     for arming exactly as for curing. A round at the anchor price is therefore not a
 *     recovery, an expiry on it still sells, and a return to it after a cure re-arms.
 *     (Fixed 2026-10-04: the cure test used that 1e-12 tolerance while the arm and
 *     re-arm tests used a bare `> line`, so an LTV in (line·(1 − 1e-12), line] neither
 *     armed nor cured.)
 *   - After any seizure the position CONTINUES with its new debt and collateral. Cross
 *     the line again and a new timer arms — that is the re-liquidation chain.
 *   - Membrane's seize is its partial repay-to-cap size (master LiquidationEngine.sol
 *     :2663-2710) grossed up by the liquidation fee, bounded only by the collateral
 *     that is left.
 *   - The repay carries the $2,000 debt floor (LE:2718-2729) AND the remainder guard
 *     (owner ruling 2026-10-04: "a liquidation must never leave 0 < remaining debt <
 *     liqDebtMinimum; if it would, repay ALL" — `applyDebtMinimum`; master has no guard,
 *     fix lane "Fix LE debt-floor dust and recall sizing"). Added 2026-10-04: this file
 *     used to size the repay with NO floor at all, so a repay of $8,964 on a $10,000 slice
 *     left $1,036 standing. The slice is treated as the whole position — the only debt
 *     this replay can see. Both the floor and the guard can only ENLARGE a seizure, so
 *     where the real account held more debt than the slice this overstates Membrane's
 *     seizures; it never manufactures a save.
 */

import { MAX_LIQ_FEE } from './compare'
import {
  BORROW_LTV_GAP,
  CURE_WINDOW_SECONDS,
  LIQ_DEBT_MINIMUM_USD,
  MAX_THRESHOLD_TO_DELAY,
  membraneRepayValue,
} from './membrane'

/** Bump when the shape of a cached scan changes. A cache row stamped with anything
 *  else is ignored and the address is rescanned — otherwise yesterday's single-event
 *  rows would be served forever against today's episode UI. */
export const HISTORY_SCHEMA_VERSION = 2

/** Two real events closer together than this are ONE episode. Oct 10's WETH hit and
 *  USDT hit are hours apart: one crash, one position, one Membrane replay. */
export const EPISODE_GAP_SECONDS = 24 * 3600

/** How far past the episode's LAST event the chain is walked. Three days is long
 *  enough for a second and third 8h window to expire on a still-falling price. */
export const EPISODE_SPAN_SECONDS = 72 * 3600

/** The fee the sim charges Membrane when the source protocol exposes no bonus to match.
 *  The scanner overrides it per reserve with that reserve's own liquidation bonus. */
export const DEFAULT_LIQ_FEE = 0.05

/** A runaway chain is a bug, not a result. Nothing real re-liquidates 12 times in 72h. */
const MAX_CHAIN = 12

/**
 * Relative band under the line that still counts as AT (= over) it — the pinned anchor
 * plus float noise from re-deriving it. Used by `overLine`, the one arm/cure boundary.
 */
const LINE_TOLERANCE = 1e-12

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
  /** 28,800 s. Real: `LIQUIDATION_DELAY_S = 8 hours`, script/DeployFullSystem.s.sol:199
   *  (passed to the engine constructor at :481). */
  cureWindowSeconds: number
  /** The break band. 4% — max_threshold_to_delay on every deploy-registered asset. */
  band: number
  /** 3pp. `borrow cap = liquidation line − gap`. Real: lib/Constants.sol:39. */
  borrowLtvGap: number
  /** Membrane's liquidation fee on the repay, 0-MAX_LIQ_FEE. Defaults to the 5% the
   *  sim uses; the scanner passes the seized reserve's own bonus where it can read it,
   *  so no save is bought with a cheaper liquidator than the real one. */
  liqFee?: number
  /** How far past the episode's last event to walk the chain. */
  spanSeconds?: number
  /** The `liqDebtMinimum` floor in USD, with the ruled remainder guard (`applyDebtMinimum`).
   *  Defaults to the deployed $2,000 (LIQ_DEBT_MINIMUM_USD); 0 disables it. */
  debtMinimumUsd?: number
}

export const DEFAULT_REPLAY_PARAMS: ReplayParams = {
  cureWindowSeconds: CURE_WINDOW_SECONDS,
  band: MAX_THRESHOLD_TO_DELAY,
  borrowLtvGap: BORROW_LTV_GAP,
  liqFee: DEFAULT_LIQ_FEE,
  spanSeconds: EPISODE_SPAN_SECONDS,
  debtMinimumUsd: LIQ_DEBT_MINIMUM_USD,
}

export type EpisodeVerdict = 'saved' | 'partial' | 'broke' | 'worse' | 'unknown'
/** Historic alias. The verdict has always described the whole outcome, not one event. */
export type ReplayVerdict = EpisodeVerdict

/** One link in the re-liquidation chain. */
export interface MembraneSeizure {
  /** Unix seconds. For an 'expired' seizure this is the timer's expiry, not a round. */
  ts: number
  kind: 'broke' | 'expired'
  usd: number
  /** The LTV that triggered it. */
  ltv: number
}

export interface EpisodeReplay {
  verdict: EpisodeVerdict
  /** What the real liquidators took across the whole episode. Passed through. */
  actualSeizedUsd: number
  /** What Membrane's WHOLE CHAIN would have taken. 0 on 'saved'. */
  membraneSeizedUsd: number
  /** How many times Membrane would have liquidated. 0 on 'saved'. */
  membraneLiquidations: number
  seizures: MembraneSeizure[]
  /** Unix seconds the position came back under its line, first time. */
  recoveredAt?: number
  /** Unix seconds the position first climbed past the break band. */
  brokeAt?: number
  /** True when the chain ate the whole position. Reported, never rounded away. */
  wiped: boolean
  /** membraneSeizedUsd / actualSeizedUsd. NOT clamped to 1 — over 1 is the 'worse'
   *  case and the UI must be able to print it. null when there is nothing to divide by. */
  membraneShare: number | null
  /** One clause, rendered as-is. Never a paragraph. */
  why: string
}

/** The old single-event result. Same fields, so existing callers keep compiling. */
export type ReplayResult = EpisodeReplay

const unknownEpisode = (actualSeizedUsd: number, why: string): EpisodeReplay => ({
  verdict: 'unknown',
  actualSeizedUsd,
  membraneSeizedUsd: 0,
  membraneLiquidations: 0,
  seizures: [],
  wiped: false,
  membraneShare: null,
  why,
})

/**
 * Cluster events into episodes: an event within `gapSeconds` of the PREVIOUS event
 * joins that episode. Input order is irrelevant; output episodes and their events are
 * ascending by ts.
 */
export function clusterEpisodes<T extends { ts: number }>(
  events: T[],
  gapSeconds: number = EPISODE_GAP_SECONDS,
): T[][] {
  const sorted = (events ?? []).slice().sort((a, b) => a.ts - b.ts)
  const out: T[][] = []
  for (const e of sorted) {
    const last = out[out.length - 1]
    const prev = last?.[last.length - 1]
    if (last && prev && e.ts - prev.ts <= gapSeconds) last.push(e)
    else out.push([e])
  }
  return out
}

/**
 * Replay ONE EPISODE against the 8-hour window, the 4% band, and the re-liquidation
 * chain that follows every seizure.
 *
 * @param events  the episode's real events. The first one anchors the position (its
 *                line, its LTV); every event's repaid debt is summed into the slice.
 * @param prices  the ANCHOR collateral's oracle rounds. Must span the first event (a
 *                round at or before it anchors the price) and the chain window after
 *                the last one. Order is irrelevant — they are sorted here.
 */
export function replayEpisode(
  events: HistoricLiquidation[],
  prices: PriceRound[],
  params: ReplayParams = DEFAULT_REPLAY_PARAMS,
): EpisodeReplay {
  const { cureWindowSeconds: W, band, borrowLtvGap } = params
  const fee = Math.max(0, Math.min(MAX_LIQ_FEE, params.liqFee ?? DEFAULT_LIQ_FEE))
  const span = params.spanSeconds ?? EPISODE_SPAN_SECONDS
  const dMin = Math.max(0, params.debtMinimumUsd ?? LIQ_DEBT_MINIMUM_USD)

  const evs = (events ?? [])
    .filter((e) => e && Number.isFinite(e.ts) && e.ts > 0)
    .slice()
    .sort((a, b) => a.ts - b.ts)
  const actual = evs.reduce((a, e) => a + Math.max(0, e.collateralSeizedUsd || 0), 0)

  if (evs.length === 0) return unknownEpisode(actual, 'no timestamped events in this episode')
  const first = evs[0]
  const last = evs[evs.length - 1]

  if (!(first.liqLine > 0) || !(first.ltvAtEvent > 0)) {
    return unknownEpisode(actual, 'no liquidation line could be read for this reserve')
  }

  const rounds = (prices ?? [])
    .filter((r) => r && Number.isFinite(r.ts) && Number.isFinite(r.price) && r.price > 0)
    .slice()
    .sort((a, b) => a.ts - b.ts)
  if (rounds.length === 0) return unknownEpisode(actual, 'no oracle rounds for this collateral')

  // Anchor price: the last round at or before the first event. If the caller only gave
  // us rounds after it we anchor on the first of them and say so — never extrapolate
  // backwards.
  const before = rounds.filter((r) => r.ts <= first.ts)
  const anchored = before.length > 0
  const p0 = anchored ? before[before.length - 1].price : rounds[0].price

  const firstWindowEnd = first.ts + W
  if (!rounds.some((r) => r.ts > first.ts && r.ts <= firstWindowEnd)) {
    return unknownEpisode(actual, 'no oracle rounds inside the 8-hour window after this event')
  }

  const line = first.liqLine
  const breakLine = line * (1 + band)
  const cap = Math.max(0, line - borrowLtvGap)

  // The position, sized off the episode: the liquidators repaid `debt` against an
  // account sitting at its line, so the collateral behind that slice is debt / ltv.
  let debt = evs.reduce((a, e) => a + Math.max(0, e.debtRepaidUsd || 0), 0)
  if (!(debt > 0)) return unknownEpisode(actual, 'no debt could be priced for this episode')
  let collQty = debt / first.ltvAtEvent / p0

  /**
   * THE boundary (header, "ONE BOUNDARY"): liquidatable = over the line, with an LTV
   * within 1e-12 of it (the pinned anchor, or float noise re-deriving it) counted as OVER.
   * Arm, re-arm and cure all read it, so they can never disagree about a position.
   */
  const overLine = (ltv: number): boolean => ltv >= line * (1 - LINE_TOLERANCE)
  /** Back under the line: out of the window — SavedByDelay clears the timer. */
  const underLine = (ltv: number): boolean => !overLine(ltv)

  const ltvAt = (price: number): number => {
    const coll = collQty * price
    return coll > 0 ? debt / coll : Infinity
  }

  const seizures: MembraneSeizure[] = []
  let membrane = 0
  let wiped = false

  /** One repay-to-cap, and the position that survives it. */
  const seize = (price: number, ts: number, kind: 'broke' | 'expired'): void => {
    const collUsd = collQty * price
    const ltv = collUsd > 0 ? debt / collUsd : Infinity
    // The floor + remainder guard (header): never leave 0 < debt < dMin on the slice.
    const repay = membraneRepayValue(debt, collUsd, cap, dMin)
    if (!(repay > 0)) return
    const gross = repay * (1 + fee)
    const usd = Math.min(gross, collUsd)
    collQty = Math.max(0, collQty - usd / price)
    // Debt falls only by what the seized collateral covered, net of the fee. Past L = 1
    // the target is the FULL debt (LE:2673-2688) but the collateral runs dry first; the
    // uncovered rest is bad debt (LE:2361-2374), not repaid. (Not observable in the
    // result today — that seizure always wipes the slice — but `debt` stays truthful.)
    const covered = usd < gross ? usd / (1 + fee) : repay
    debt = Math.max(0, debt - Math.min(covered, debt))
    membrane += usd
    seizures.push({ ts, kind, usd, ltv })
    if (collQty * price <= 1e-9 || debt <= 1e-9) wiped = true
  }

  const spanEnd = last.ts + span
  const walk = rounds.filter((r) => r.ts > first.ts && r.ts <= spanEnd)
  // A tail round at the span end, holding the last observed price. Chainlink prints on
  // heartbeat or deviation, so "no round" means "the price did not move" — an armed
  // timer must still be allowed to expire on that flat price, not escape unresolved.
  if (walk.length > 0) {
    const tail = walk[walk.length - 1]
    if (spanEnd > tail.ts) walk.push({ ts: spanEnd, price: tail.price })
  }

  let armed = true // the first event IS the crossing: the position is at its line
  let timerStart = first.ts
  let lastPrice = p0
  let recoveredAt: number | undefined
  let brokeAt: number | undefined

  for (const r of walk) {
    // 1. Any timer that expired STRICTLY BEFORE this round resolves at the price that
    //    was standing at expiry — not at this round's price, which the position never
    //    saw while the window was open.
    while (armed && !wiped && r.ts > timerStart + W && seizures.length < MAX_CHAIN) {
      const at = timerStart + W
      // Back under the line the position is not liquidatable: the timer just clears
      // (strict: see CURE AT THE LINE in the header).
      if (underLine(ltvAt(lastPrice))) {
        armed = false
        recoveredAt = recoveredAt ?? at
        break
      }
      seize(lastPrice, at, 'expired')
      armed = false
      // The repay restores the cap net of debt but the FEE comes out of collateral, so
      // the survivor can still be over the line. If it is, a new timer arms right there.
      if (!wiped && overLine(ltvAt(lastPrice))) {
        armed = true
        timerStart = at
      }
    }
    if (wiped || seizures.length >= MAX_CHAIN) break

    lastPrice = r.price
    const ltv = ltvAt(r.price)

    if (!armed && overLine(ltv)) {
      armed = true
      timerStart = r.ts
    }
    if (armed) {
      if (ltv > breakLine) {
        seize(r.price, r.ts, 'broke')
        brokeAt = brokeAt ?? r.ts
        armed = false
        if (!wiped && overLine(ltvAt(r.price))) {
          armed = true
          timerStart = r.ts
        }
      } else if (underLine(ltv)) {
        // Back under the line: SavedByDelay clears the timer (LE:1666-1685).
        armed = false
        recoveredAt = recoveredAt ?? r.ts
      }
    }
    if (wiped || seizures.length >= MAX_CHAIN) break
  }

  const share = actual > 0 ? membrane / actual : null
  const n = seizures.length
  const times = `${n} Membrane liquidation${n === 1 ? '' : 's'}`
  const anchorNote = anchored ? '' : ' (price anchored on the first round after the event)'

  if (n === 0) {
    return {
      verdict: 'saved',
      actualSeizedUsd: actual,
      membraneSeizedUsd: 0,
      membraneLiquidations: 0,
      seizures,
      recoveredAt,
      wiped: false,
      membraneShare: share,
      why:
        recoveredAt !== undefined
          ? `price was back under the liquidation line ${minutesAfter(first.ts, recoveredAt)} after the first hit, inside the 8-hour window — nothing sold${anchorNote}`
          : `the position never sat over its line at a window expiry — nothing sold${anchorNote}`,
    }
  }

  // 'worse' outranks everything else. If the chain cost at least what the real
  // liquidators took, that is the headline fact about this episode and the UI prints
  // it in blood — a 'broke' label with a 90% share would bury it.
  const verdict: EpisodeVerdict =
    actual > 0 && membrane >= actual ? 'worse' : brokeAt !== undefined ? 'broke' : 'partial'

  const wipedNote = wiped ? ', and the chain took the whole slice' : ''
  const why =
    verdict === 'worse'
      ? `re-liquidated ${times} over the ${Math.round(span / 3600)}h after the first hit — more than the real liquidator took${wipedNote}`
      : brokeAt !== undefined
        ? `price kept falling — LTV passed the ${(band * 100).toFixed(0)}% break band ${minutesAfter(first.ts, brokeAt)} after the first hit, so the sale is immediate; ${times} in all${wipedNote}`
        : `still over the line when the 8-hour window ran out — ${times}, repaying only to the borrow cap each time${wipedNote}${anchorNote}`

  return {
    verdict,
    actualSeizedUsd: actual,
    membraneSeizedUsd: membrane,
    membraneLiquidations: n,
    seizures,
    recoveredAt,
    brokeAt,
    wiped,
    membraneShare: share,
    why,
  }
}

/**
 * ONE event, replayed. A thin wrapper over `replayEpisode` — a single event is just an
 * episode of one, and it still chains: a partial that re-crosses its line inside the
 * span is liquidated again, exactly as the owner ruling requires.
 */
export function replayLiquidation(
  ev: HistoricLiquidation,
  prices: PriceRound[],
  params: ReplayParams = DEFAULT_REPLAY_PARAMS,
): ReplayResult {
  return replayEpisode([ev], prices, params)
}

function minutesAfter(from: number, to: number): string {
  const mins = Math.max(0, Math.round((to - from) / 60))
  if (mins < 60) return `${mins} min`
  const h = Math.floor(mins / 60)
  const m = mins % 60
  return m === 0 ? `${h}h` : `${h}h ${m}m`
}

// ------------------------------------------------------------------- totals

/** One real, decoded liquidation as the API serves it. The VERDICT is not here: a
 *  verdict belongs to the episode, because the chain crosses event boundaries. */
export interface HistoryEvent {
  ts: number
  protocol: string
  /** Collateral symbol, or the raw address when we could not name it. */
  collateral: string
  actualSeizedUsd: number
  /** USD the liquidator repaid. 0 when it could not be priced. */
  debtRepaidUsd?: number
  /** True when this event could not be priced or lined. It still shows in its episode's
   *  event list — we never silently drop a liquidation that happened. */
  unpriced?: boolean
  /** Why it is unpriced, in one clause. */
  why?: string
}

/** One cluster of real events plus the Membrane chain replayed against it. */
export interface HistoryEpisode {
  /** First event's ts. */
  startTs: number
  /** Last event's ts. */
  endTs: number
  /** 'Aave V3', or 'Aave V3 + Morpho Blue' when the crash hit two venues. */
  protocol: string
  /** The anchor collateral, or 'WETH + USDT' when the episode spans several. */
  collateral: string
  events: HistoryEvent[]
  actualSeizedUsd: number
  membraneSeizedUsd: number
  membraneLiquidations: number
  verdict: EpisodeVerdict
  membraneShare: number | null
  recoveredAt?: number
  brokeAt?: number
  wiped?: boolean
  why: string
}

export interface HistoryTotals {
  /** Collateral that would still be yours: the episodes Membrane avoided entirely. */
  savedUsd: number
  savedCount: number
  /** Collateral Membrane would still have KEPT on the episodes it could not save. */
  partialKeptUsd: number
  partialCount: number
  brokeCount: number
  /** Episodes where the CHAIN cost at least what the real liquidator did. Reported. */
  worseCount: number
  unknownCount: number
  /** How many times Membrane would have liquidated, across every episode. */
  membraneLiquidationsTotal: number
}

export const ZERO_TOTALS: HistoryTotals = {
  savedUsd: 0,
  savedCount: 0,
  partialKeptUsd: 0,
  partialCount: 0,
  brokeCount: 0,
  worseCount: 0,
  unknownCount: 0,
  membraneLiquidationsTotal: 0,
}

/** Sum the replayed episodes. 'unknown' contributes to `unknownCount` and to NOTHING
 *  else — an episode we could not price is never counted as a save or as a loss. */
export function totalHistory(episodes: HistoryEpisode[]): HistoryTotals {
  const t: HistoryTotals = { ...ZERO_TOTALS }
  for (const e of episodes) {
    if (e.verdict === 'unknown') {
      t.unknownCount += 1
      continue
    }
    t.membraneLiquidationsTotal += e.membraneLiquidations
    if (e.verdict === 'saved') {
      t.savedUsd += e.actualSeizedUsd
      t.savedCount += 1
    } else if (e.verdict === 'partial') {
      t.partialKeptUsd += Math.max(0, e.actualSeizedUsd - e.membraneSeizedUsd)
      t.partialCount += 1
    } else if (e.verdict === 'broke') {
      t.brokeCount += 1
    } else {
      t.worseCount += 1
    }
  }
  return t
}

/** A protocol this scan did not cover, and the reason. Printed verbatim, never a bare
 *  name — "not scanned" without a reason reads as "we forgot". */
export interface NotScanned {
  protocol: string
  reason: string
}

/** The API response shape. Shared by the route, the UI and the offline script. */
export interface HistoryResponse {
  address: string
  since: { firstEventTs: number | null }
  /** The unit of the proof. Each one lists the real events behind it. */
  episodes: HistoryEpisode[]
  /** Every decoded event, flat and in time order, for the record. */
  events: HistoryEvent[]
  totals: HistoryTotals
  /** How this was measured, verbatim. Rendered as one fine-print bullet. */
  method: string
  provenance: 'observed' | 'modelled'
  scannedAt: string
  /** The head block the scan reached, as a decimal string (JSON has no bigint). Stored
   *  on the cache row so a later incremental scan knows where this one stopped. */
  scannedToBlock?: string
  /** Protocols this scan did NOT cover, with reasons. Named on screen. */
  notScanned?: NotScanned[]
  /** HISTORY_SCHEMA_VERSION at the time of the scan. A cache row with any other value
   *  is stale by construction and gets rescanned. */
  version?: number
  /** Present only when the scan itself failed. The UI prints it and shows no number. */
  error?: string
}
