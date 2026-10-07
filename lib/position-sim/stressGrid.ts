/**
 * stressGrid — fixed, named stress scenarios run through Membrane's liquidation mechanics
 * for ONE position. ENGINE ONLY: it returns numbers and machine codes, never copy (the one
 * exception is EXIT_CAPACITY_PRESETS' labels and one-line provenance notes, data for the UI's
 * picker).
 *
 * A node is a position (collateral, debt, line, class, trade shape, deployed venue capital)
 * plus ONE scenario (a price shape, optionally a venue condition), walked step by step
 * through the SAME `DelayTimer` the Oct-10 census (`cureWalk`) and the per-address
 * simulator (`compare.ts`) run. Every node is a stress scenario — not a forecast, not a
 * probability (`STRESS_LABEL`) — and reproduces from its `cellKey`: a hash of the
 * NORMALIZED inputs plus `STRESS_CODE_VERSION`. The walk runs on the normalized inputs,
 * so one key always means one set of outputs.
 *
 * ---------------------------------------------------------------------------
 * MASTER MECHANICS (membrane-solidity master 10626e40; LE = contracts/LiquidationEngine.sol)
 * ---------------------------------------------------------------------------
 *  - A keeper calls `liquidate` at every step the pre-recall LTV is over the line
 *    (MODELLED cadence: one call per grid step).
 *  - Every call recalls venue capital FIRST (LE:1106-1107). The ASK is set by owner ruling,
 *    not master — see INTENDED RULES below.
 *  - A recall that brings the LTV to the line or under COMMITS and never arms a timer;
 *    an armed timer is cleared (recall-only lane, LE:1623-1658)        → 'recall_cured'
 *  - Otherwise the call is classified on the POST-recall LTV (LE:1572-1576, :1690-1704):
 *      past the threshold          sale now (Immediate / BrokeWindow)
 *      timer expired               sale now (DelayExpired)
 *      in the band, no timer       TimerStarted — the recall COMMITS (LE:1112-1131)
 *      in the band, timer running  TimerActive REVERT (LE:1690) — the recall is rolled back
 *    The no-delay class runs in instant mode (band 0, LE:1572): threshold = line, so it
 *    can never arm (LE:1708-1710).
 *  - A sale's target is the partial repay sized on the PRE-recall debt (`p.totalDebt`,
 *    read at LE:1311 and never refreshed) at the POST-recall LTV (`currentLtv`, re-read in
 *    step 2), LE:1759 → `_getRepayQuantities` LE:2663-2729; collateral covers
 *    `target − recalled`. Reproduced here by passing `debt / ltvPost` as the collateral
 *    argument of `membraneRepayValue`, so there is still ONE repay formula.
 *    That stale-debt sizing is master's and is KEPT here: it is a separate Low defect with
 *    its own fix lane ("Fix LiquidationEngine partial-recall sale sizing").
 *  - The recall can EXCEED that target (LE:1757-1760 only narrows the target). Then
 *    nothing is sold, the call commits with the position still OVER the line and its
 *    timer cleared (Cdp.liquidate STEP 6, Cdp.sol:2380-2405, only requires the LTV not
 *    to rise)                                                         → 'recall_liquidated'
 *  - A return to the line or under clears an armed timer (SavedByDelay) — DelayTimer.
 *  - Collateral worth ≤ $1e-6 with debt owed (a replay that reaches zero) is a breach
 *    past every threshold: recall first, then a sale of everything left; the rest is
 *    bad debt (LE:2361-2374).
 *
 * ---------------------------------------------------------------------------
 * INTENDED RULES, NOT MASTER (owner rulings 2026-10-04; each master gap has a fix lane,
 * AGENT_BOARD.md "OWNER RULINGS ON MECHANICS")
 * ---------------------------------------------------------------------------
 *  - RECALL SIZING: a call asks the venues only for what restores the position to its
 *    borrow LTV (`membraneRecallTarget`: loan − B × collateral, floored) — "only attempt
 *    to liquidate and therefore recall from LLTV to borrowable LTV". Master asks for the
 *    FULL debt: `repayTarget = totalDebt` (LE:1320), each venue sends
 *    `min(retrievable, repayTarget − totalRepaid)` (LE:1453). What arrives is still capped
 *    by the venue stock below.
 *  - DEBT FLOOR: a repay never leaves 0 < debt < dMin; it repays all (`applyDebtMinimum`'s
 *    remainder guard). Master LE:2718-2729 has no guard. The guard also binds what a call
 *    ACTUALLY repays: a recall that arrives short of an ask already escalated to the whole
 *    loan, and would commit (recall-only cure, TimerStarted) leaving 0 < debt < dMin,
 *    makes the call repay all — collateral sells the remainder (`debtFloorRemainder`,
 *    saleReason 'floor'). Master's recall-only lane (LE:1623-1658) has no floor at all.
 *  - SAVED: back at or under the line clears the timer — this one matches master.
 *
 * ---------------------------------------------------------------------------
 * MODELLED, NOT MASTER (state these wherever a node is shown)
 * ---------------------------------------------------------------------------
 *  - Venue recall is a STOCK: `min(deployedUsd, exitCapacityUsd × capacityMult)`, drawn
 *    down by every committed recall and never refilled across the horizon. A freeze makes it unavailable for
 *    `freezeHours` from the FIRST breach (the moment recall is first needed): the longer of
 *    the scenario's freeze and the preset's measured lock.
 *  - Exit capacity is an EXPLICIT input for a carry position with capital deployed —
 *    `exitCapacityUsd`, or a named `exitCapacityPreset` (EXIT_CAPACITY_PRESETS: measured
 *    venue analogs, owner instruction 2026-10-06), or a custom `exitCapacityMult`. There is
 *    no silent default: owner ruling 2026-10-04 — assuming the whole deployed amount is
 *    withdrawable is the MOST optimistic case, so it must be chosen, never assumed. A
 *    carry node with deployed capital and none of them is `not_modelled`
 *    ('no_exit_capacity'). A measured analog is, as the HEADLINE, a real venue's idle cash
 *    in a real stress event against Membrane's whole book there (cash vs book, owner ruling
 *    2026-10-07), or, as the FLOOR, the pro-rata share every depositor would get if all
 *    exited at once: descriptive history, not a forecast of the next one. The stock never
 *    refills across the horizon.
 *  - Debt (CDT) is held at $1; the price shape moves the whole collateral value.
 *  - After the shape ends the price holds at its last value for one full window plus a
 *    step, so every armed timer resolves inside the horizon (no grid-end guess).
 *  - OMITTED: the keeper fee ramp `min((L − T)/L, 20%)`, gas stipend and protocol
 *    `_liqFee` (LE:1817-1835) — they are paid from collateral, even on a recall-only cure,
 *    so `exposedUsd` UNDERSTATES what leaves the position; interest accrual; the
 *    gas-indexed debt floor (LE:2719-2720); slippage and MEV; the 2 × delay stale-timer
 *    amnesty (LE:1590-1594, cannot bind: every timer resolves at its expiry here).
 */

import { DelayTimer } from './curePath'
import {
  LIQ_DEBT_MINIMUM_USD,
  MEMBRANE_CLASS_PARAMS,
  applyDebtMinimum,
  debtFloorRemainder,
  membraneRecallTarget,
  membraneRepayValue,
  weightedMembraneLine,
  type MembraneClass,
} from './membrane'
import {
  EXIT_CAPACITY_ANALOG_LEVELS,
  EXIT_CAPACITY_ANALOG_ROWS,
  EXIT_CAPACITY_ANALOG_VENUES,
  EXIT_CAPACITY_BOOKS,
  EXIT_CAPACITY_DEFAULT_BOOK,
  type ExitCapacityAnalogId,
  type ExitCapacityAnalogLevel,
  type ExitCapacityAnalogRow,
  type ExitCapacityAnalogVenue,
  type ExitCapacityBookId,
  type ExitCapacityBookPresetId,
  type ExitCapacityFloorId,
  type ExitCapacityModel,
} from './exitCapacityAnalogs'
import { SYMBOL_TO_SERIES, type Oct10Series } from './scenario'
import type { ProtocolPosition } from './types'

// ---------------------------------------------------------------- constants

/** Bumped whenever the walk, the normalization or the key changes. Part of every key. */
export const STRESS_CODE_VERSION =
  'stress-grid/5 · membrane-solidity master 10626e40 + owner rulings 2026-10-04'

/** The only label a node carries. */
export const STRESS_LABEL = 'stress scenario — not a probability'

/** Grid resolution for synthetic shapes, matching the Oct-10 1-minute series. */
export const STRESS_DEFAULT_STEP_SECONDS = 60

/** Same cap as cureWalk's DEFAULT_MAX_SALES. */
export const MAX_STRESS_SALES = 20

const DUST_USD = 1e-6

// -------------------------------------------------------------------- types

/**
 * 'carry'        the debt is DEPLOYED in a venue: recall is available before collateral.
 * 'levered_long' the debt was re-collateralised: no recall rows; only the window defends.
 */
export type TradeShape = 'carry' | 'levered_long'

/**
 * Named exit-capacity levels a carry position can be run at. Owner instruction 2026-10-06:
 * "the venue-capacity assumptions should directly analogize existing protocols (assuming
 * typical Aave capacity during stress over the last 3 years)". So every level but the two
 * bounds is a MEASURED ANALOG of one real venue in one real stress event, 2023-10 → 2026-10
 * (exitCapacityAnalogs.ts; method venueStressAnalogs.ts): per venue the median ('typical'),
 * 10th-percentile ('bad') and worst ('worst') of its stress events over the 8 h window.
 * Exit capacity = deployedUsd × `mult` in two models (owner ruling 2026-10-07):
 *   CASH VS BOOK — the HEADLINE, ids '<venue>-<book>-<level>' (book '10m' | '50m' | '250m'):
 *     mult = m(B) = min(1, idle cash / B), the venue's idle cash in that hour against
 *     Membrane's whole book B at the venue. Assumptions (stated wherever shown): (i) the
 *     whole book recalls at once (conservative); (ii) the observed cash is first come within
 *     the hour and already net of everyone else who withdrew in it; (iii) Membrane's recall
 *     does not itself trigger a run; (iv) the stock never refills across the horizon.
 *   PRO-RATA FLOOR — ids '<venue>-floor-<level>': mult = f = cash / supply, every depositor
 *     exits at once and a recall gets its pro-rata share of the cash. On the SAME event it is
 *     the worst case for any book the venue could hold (B ≤ supply ⇒ cash / B ≥ cash / supply).
 *     A cash-vs-book row whose book is larger than the venue's whole supply in the window
 *     (m < the same window's f) is a book that could not exist there — Membrane's deposit is
 *     part of the supply — and is FLAGGED (`bookExceedsVenue`, label '· book exceeds the
 *     venue'), not dropped (one row per venue × book × level, owner ruling 2026-10-07).
 *   `freezeHours` = the measured lock (mult ≤ 1%) when the event is locked: the venue answers
 *     nothing for that long from the first breach (exitCapacityAnalogs.ts header: it starts
 *     up to 8 h early, and the recovery after it is not modelled).
 * The bounds: 'frozen' (×0, nothing comes back — a paused reserve or a recall that loses the
 * race) and 'optimistic' (×1, an UPPER BOUND only, never a default: owner ruling 2026-10-04,
 * "assuming the whole deployed amount is withdrawable is the most optimistic case"). A
 * measured cash-vs-book level can also resolve to ×1 (the idle cash covered the whole book);
 * its label then says so ('×1, cash covers the book'), so a ×1 is never silent.
 * A custom multiple is `exitCapacityMult`.
 */
export type ExitCapacityBoundId = 'frozen' | 'optimistic'
export type ExitCapacityPresetId = ExitCapacityAnalogId | ExitCapacityBoundId

export interface ExitCapacityPreset {
  readonly id: ExitCapacityPresetId
  readonly kind: 'measured' | 'theoretical-bound' | 'upper-bound'
  /** 'cash-vs-book' (headline) or 'pro-rata' (floor) for a measured level; null for a bound. */
  readonly model: ExitCapacityModel | null
  /** Membrane's whole book at the venue, USD (cash-vs-book only). */
  readonly bookUsd: number | null
  /** Short picker name, e.g. 'Aave USDC · $50M book · typical · ×1, cash covers the book'. */
  readonly label: string
  /** Exit capacity = deployedUsd × mult. */
  readonly mult: number
  /** The venue answers nothing for this long from the first breach, hours (a measured lock). */
  readonly freezeHours: number
  /** One line: where the level comes from. Data the UI can show next to the choice. */
  readonly provenance: string
  /** The measured source (venue, event, windows, date range, n). Null for a bound. */
  readonly source: ExitCapacityAnalogRow | null
}

const LEVEL_LABEL: Readonly<Record<ExitCapacityAnalogLevel, string>> = {
  typical: 'typical',
  bad: 'bad (p10)',
  worst: 'worst seen',
}

const BOOK_LABEL = Object.fromEntries(EXIT_CAPACITY_BOOKS.map((b) => [b.id, b.label])) as Record<
  ExitCapacityBookId,
  string
>

/** A measured row's picker label. A ×1 always says so; so does a book the venue could not hold. */
function analogLabel(r: ExitCapacityAnalogRow): string {
  const model = r.model === 'cash-vs-book' ? `${BOOK_LABEL[r.book]} book` : 'floor (everyone exits)'
  const exceeds =
    r.model === 'cash-vs-book' && r.bookExceedsVenue ? ' · book exceeds the venue' : ''
  return `${r.venueName} · ${model} · ${LEVEL_LABEL[r.level]}${r.mult >= 1 ? ' · ×1, cash covers the book' : ''}${exceeds}`
}

export const EXIT_CAPACITY_BOUNDS: Readonly<Record<ExitCapacityBoundId, ExitCapacityPreset>> = {
  frozen: {
    id: 'frozen',
    kind: 'theoretical-bound',
    model: null,
    bookUsd: null,
    label: 'Frozen · ×0',
    mult: 0,
    freezeHours: 0,
    provenance:
      'Nothing comes back: a paused reserve, or a recall that loses the exit race. The theoretical lower bound.',
    source: null,
  },
  optimistic: {
    id: 'optimistic',
    kind: 'upper-bound',
    model: null,
    bookUsd: null,
    label: 'Upper bound · ×1',
    mult: 1,
    freezeHours: 0,
    provenance:
      'Everything deployed comes back on demand, in every scenario. An upper bound only, never a default (owner ruling 2026-10-04).',
    source: null,
  },
}

export const EXIT_CAPACITY_PRESETS: Readonly<Record<ExitCapacityPresetId, ExitCapacityPreset>> =
  Object.freeze({
    ...(Object.fromEntries(
      EXIT_CAPACITY_ANALOG_ROWS.map((r) => [
        r.id,
        {
          id: r.id,
          kind: 'measured',
          model: r.model,
          bookUsd: r.bookUsd,
          label: analogLabel(r),
          mult: r.mult,
          freezeHours: r.freezeHours,
          provenance: r.provenance,
          source: r,
        } satisfies ExitCapacityPreset,
      ]),
    ) as Record<ExitCapacityAnalogId, ExitCapacityPreset>),
    ...EXIT_CAPACITY_BOUNDS,
  })

/** A measured preset id from its parts: a book ('10m' | '50m' | '250m') or the 'floor'. */
export function exitCapacityPresetId(
  venue: ExitCapacityAnalogVenue,
  book: ExitCapacityBookId | 'floor',
  level: ExitCapacityAnalogLevel,
): ExitCapacityBookPresetId | ExitCapacityFloorId {
  return book === 'floor'
    ? (`${venue}-floor-${level}` as ExitCapacityFloorId)
    : (`${venue}-${book}-${level}` as ExitCapacityBookPresetId)
}

/** The measured venues, picker order, each with its three levels per book and on the floor. */
export const EXIT_CAPACITY_VENUES: readonly {
  slug: ExitCapacityAnalogVenue
  name: string
  asset: 'stable' | 'eth'
  books: Readonly<Record<ExitCapacityBookId, readonly ExitCapacityBookPresetId[]>>
  floor: readonly ExitCapacityFloorId[]
}[] = EXIT_CAPACITY_ANALOG_VENUES.map((v) => ({
  slug: v.slug,
  name: v.name,
  asset: v.asset,
  books: Object.fromEntries(
    EXIT_CAPACITY_BOOKS.map((b) => [
      b.id,
      EXIT_CAPACITY_ANALOG_LEVELS.map(
        (l) => exitCapacityPresetId(v.slug, b.id, l) as ExitCapacityBookPresetId,
      ),
    ]),
  ) as unknown as Record<ExitCapacityBookId, readonly ExitCapacityBookPresetId[]>,
  floor: EXIT_CAPACITY_ANALOG_LEVELS.map(
    (l) => exitCapacityPresetId(v.slug, 'floor', l) as ExitCapacityFloorId,
  ),
}))

/** Display order: per measured venue its books ($10M, $50M, $250M; typical, bad, worst), then
 *  its floor; then 'frozen', then the upper bound 'optimistic' last. */
export const EXIT_CAPACITY_PRESET_ORDER: readonly ExitCapacityPresetId[] = [
  ...EXIT_CAPACITY_VENUES.flatMap((v) => [
    ...EXIT_CAPACITY_BOOKS.flatMap((b) => v.books[b.id]),
    ...v.floor,
  ]),
  'frozen',
  'optimistic',
]

/** The default level: typical Aave USDC stress at a $50M book (owner ruling 2026-10-07). */
export const EXIT_CAPACITY_DEFAULT_PRESET: ExitCapacityPresetId = exitCapacityPresetId(
  'aave-usdc',
  EXIT_CAPACITY_DEFAULT_BOOK,
  'typical',
)

/** Exit capacity, USD, for a deployed amount at a named level. */
export function exitCapacityFromPreset(deployedUsd: number, preset: ExitCapacityPresetId): number {
  return Math.max(0, deployedUsd) * EXIT_CAPACITY_PRESETS[preset].mult
}

/**
 * The everyone-exits (pro-rata floor) preset at a measured preset's OWN venue and level:
 * '<venue>-<book>-<level>' and '<venue>-floor-<level>' both give '<venue>-floor-<level>'. Null
 * for a bound ('frozen', 'optimistic') or an unknown id: they name no venue to exit from.
 */
export function exitCapacityFloorOf(preset: ExitCapacityPresetId): ExitCapacityFloorId | null {
  if (!Object.prototype.hasOwnProperty.call(EXIT_CAPACITY_PRESETS, preset)) return null
  const src = EXIT_CAPACITY_PRESETS[preset].source
  return src ? (exitCapacityPresetId(src.slug, 'floor', src.level) as ExitCapacityFloorId) : null
}

/**
 * Capacity CUTS measured against the default preset, as multiples of it (so they scale
 * whatever capacity a position chose, like any `capacityMult`): at the default venue,
 *   'bad'    its bad (p10) event at the same book ÷ its typical event;
 *   'floor'  its typical event when every depositor exits at once (pro-rata) ÷ the default.
 * They replace the named ×0.5 / ×0.1 cuts of the swatch grid (DEFAULT_CAPACITY_MULTS). A cut
 * is NOT an everyone-exits level for any other preset: the tree's everyone-exits lane runs the
 * chosen venue's own floor (`exitCapacityFloorOf`, `VenueStress.exitCapacityPreset`).
 * Empty when the default measures nothing to cut from (mult 0).
 */
export const EXIT_CAPACITY_DEFAULT_CUTS: readonly {
  id: 'bad' | 'floor'
  /** The measured preset the cut comes from. */
  from: ExitCapacityPresetId
  mult: number
}[] = (() => {
  const d = EXIT_CAPACITY_PRESETS[EXIT_CAPACITY_DEFAULT_PRESET]
  const src = d.source
  if (!src || !(d.mult > 0)) return []
  const book = src.model === 'cash-vs-book' ? src.book : 'floor'
  const cut = (id: 'bad' | 'floor', from: ExitCapacityPresetId) => ({
    id,
    from,
    mult: Math.round((EXIT_CAPACITY_PRESETS[from].mult / d.mult) * 1e4) / 1e4,
  })
  return [
    cut('bad', exitCapacityPresetId(src.slug, book, 'bad')),
    cut('floor', exitCapacityPresetId(src.slug, 'floor', src.level)),
  ]
})()

export interface StressPosition {
  /** Collateral value at t0, USD. */
  collateralUsd: number
  /** Debt value at t0, USD (CDT held at $1). */
  debtUsd: number
  /** The liquidation line (max LTV). Must sit in (0, class ceiling]. */
  line: number
  membraneClass: MembraneClass
  tradeShape: TradeShape
  /** Debt value deployed in venues. Carry only; ignored for levered_long. Default 0. */
  deployedUsd?: number
  /**
   * The venue's instant exit capacity for this position, USD. Carry only. NO DEFAULT:
   * a carry position with `deployedUsd > 0` must give this OR `exitCapacityPreset`
   * (owner ruling 2026-10-04 — full withdrawability is the most optimistic case, so it is
   * never assumed). Wins over the preset when both are given. The scenario's
   * `capacityMult` scales it.
   */
  exitCapacityUsd?: number
  /**
   * A named exit-capacity level (EXIT_CAPACITY_PRESETS) resolved against `deployedUsd`:
   * exit capacity = deployedUsd × preset multiplier, and the venue answers nothing for the
   * preset's measured lock (`freezeHours`) from the first breach. Carry only.
   */
  exitCapacityPreset?: ExitCapacityPresetId
  /**
   * A custom exit capacity as a MULTIPLE of `deployedUsd` (0–1 in the UI), resolved exactly
   * like a preset — so `withStartLtv`, which scales the deployed amount with the debt,
   * scales the capacity with it. A custom ×m is then the same node as an unlocked preset
   * with mult m. (The sandbox used to turn a custom multiplier into a fixed
   * `exitCapacityUsd`, which the reverse solve holds in dollars: "custom ×0.50" and the
   * ×0.5 preset of the time disagreed.) A custom multiple carries no lock.
   * Precedence: `exitCapacityUsd`, then `exitCapacityPreset`, then this. Carry only.
   */
  exitCapacityMult?: number
  /** `liqDebtMinimum`. Default LIQ_DEBT_MINIMUM_USD ($2,000, Deploy:486). */
  debtMinimumUsd?: number
}

/** Collateral price relative to t0. Index 0 is "now"; drops are fractions in [0, 1). */
export type PriceShape =
  /** One step down at the first grid step, held. */
  | { kind: 'step'; drop: number }
  /** A straight decline from t0 to `drop` over `hours`, held. */
  | { kind: 'linear'; drop: number; hours: number }
  /** A step down held for `hours`, then a recovery of `recover` (share of the drop, default 1). */
  | { kind: 'wick'; drop: number; hours: number; recover?: number }
  /** A measured path, relative to its first observation (see oct10ReplayShape). */
  | { kind: 'replay'; id: string; stepSeconds: number; ratios: readonly (number | null)[] }

export interface VenueStress {
  /** Scales the venue exit capacity. Default 1. */
  capacityMult?: number
  /** Venue answers nothing for this long from the first breach. Default 0. */
  freezeHours?: number
  /**
   * An ABSOLUTE venue condition: this measured level REPLACES the position's exit capacity
   * (resolved against `deployedUsd`, whatever the position chose — `exitCapacityUsd`, a preset
   * or a custom multiple) and its measured lock replaces the position's lock. `capacityMult`
   * and `freezeHours` then apply on top of it as usual. A cut (`capacityMult`) scales what
   * the position chose; this does not — e.g. the tree's everyone-exits lane runs the chosen
   * venue's own pro-rata floor (`exitCapacityFloorOf`). Carry only: a levered long is not
   * modelled under it ('no_recall_levered_long'); an unknown id is 'invalid_venue'.
   * Absent, the normalized inputs and so every cell key are byte-identical to a scenario
   * without the field (it is written to the key only when set), so STRESS_CODE_VERSION stands.
   */
  exitCapacityPreset?: ExitCapacityPresetId
}

export interface StressScenario {
  price: PriceShape
  venue?: VenueStress
}

export interface StressRunOptions {
  /** Grid step for synthetic shapes. A replay always runs on its own step. Default 60. */
  stepSeconds?: number
}

export type StressOutcome =
  | 'no_breach'
  | 'recall_cured'
  | 'armed_cured'
  | 'recall_liquidated'
  | 'sold'
  | 'not_modelled'

/**
 * Severity order. "rank >= recall_liquidated" (the call reached the SALE PATH) never falls
 * as a shock deepens (tests/unit/stressGrid.test.ts ladders). The top pair is NOT monotone
 * everywhere: the floor (LE:2721-2728) lifts a sub-dMin target to the WHOLE loan when the
 * loan is under 2·dMin but only to dMin above it, so where the debt at the sale call
 * crosses 2·dMin (the reverse solve's LTV axis) a deeper shock can turn `sold` into
 * `recall_liquidated` and back (tests/unit/frontier.test.ts, repro C). Under master's
 * no-guard floor the same island also opened at a FIXED debt in [dMin, 2·dMin) on the
 * price axis; the ruled remainder guard (owner 2026-10-04) closes that one — every target
 * there is the whole loan. The FLOOR CLOSE (ruling 1 on what a call actually repays: a
 * short recall that would strand 0 < debt < dMin sells the remainder, saleReason 'floor')
 * ranks `sold` without the sale path, and only while the debt at the call is small — so a
 * larger start LTV (reverse solve) or a deeper capacity cut can turn `sold` back into
 * `recall_cured`. frontier.ts solves every edge around what remains (its header).
 *   no_breach          the line was never crossed
 *   recall_cured       crossed; venue recall alone brought it back to the line in the same
 *                      call, leaving no debt under the floor (else: the floor close, `sold`);
 *                      no timer was armed (master never arms a healthy position,
 *                      LE:1623-1658)
 *   armed_cured        the delay timer armed and was later cleared with nothing sold (price
 *                      recovered, or a recall landed inside the window). Delayed class only.
 *   recall_liquidated  a call took the SALE path (Immediate / BrokeWindow / DelayExpired) but
 *                      its recall covered the whole repay target, so no collateral was sold;
 *                      the position was left OVER the line. Never arms (`armed` untouched),
 *                      so the no-delay class can reach it. Ranked above armed_cured: the
 *                      window was broken (or ran out), and a slightly larger shock sells.
 *   sold               collateral was sold
 */
export const STRESS_SEVERITY: Readonly<Record<Exclude<StressOutcome, 'not_modelled'>, number>> = {
  no_breach: 0,
  recall_cured: 1,
  armed_cured: 2,
  recall_liquidated: 3,
  sold: 4,
}

export type NotModelledReason =
  | 'invalid_position'
  /** A carry position with deployed capital and no explicit exit capacity (ruling 5). */
  | 'no_exit_capacity'
  | 'line_out_of_class_range'
  | 'invalid_shape'
  | 'invalid_venue'
  | 'no_recall_levered_long'
  | 'mixed_class'
  | 'no_line'

interface StressResultBase {
  cellKey: string
  codeVersion: string
  label: string
  scenarioId: string
}

export interface StressNotModelled extends StressResultBase {
  outcome: 'not_modelled'
  reason: NotModelledReason
}

export interface StressModelled extends StressResultBase {
  outcome: Exclude<StressOutcome, 'not_modelled'>
  membraneClass: MembraneClass
  tradeShape: TradeShape
  startLtv: number
  line: number
  /** line × (1 + band). Equal to the line for the no-delay class. */
  breakLine: number
  /** Highest pre-recall LTV the walk saw. Infinity when the collateral reached $0 with
   *  debt owed (an unbounded LTV), very large when it reached near-$0. */
  peakLtv: number
  /** LTV at the end of the horizon, after every recall and sale. Null if no collateral is left. */
  landingLtv: number | null
  /** Collateral value SOLD, USD, at sale-time prices. Fees omitted (understated). */
  exposedUsd: number
  /**
   * Share of the starting collateral (in units) sold, 0–1. NOT monotone in the shock — do
   * not rank scenarios on it. It can FALL as a shock deepens: (a) crossing the band break
   * switches an expiry sale sized on the debt AFTER the arm call's committed recall to an
   * immediate sale sized on the pre-recall debt with the recall netted off; (b) under
   * master's no-guard floor only, a deeper shock in the [dMin, 2·dMin) debt band shrank the
   * target from the whole loan to its partial size — closed by the ruled remainder guard
   * (tests/unit/stressGrid.test.ts). The outcome rank, not this, orders scenarios.
   */
  soldShare: number
  /** Debt repaid, by recall and by sales. */
  closedUsd: number
  /** Debt left once the collateral ran out. */
  badDebtUsd: number
  /** Calls that sold collateral. */
  sales: number
  /** Whether a delay timer ever armed. Always false for the no-delay class. */
  armed: boolean
  /**
   * Why the FIRST sale ran: 'band' = Immediate/BrokeWindow, 'expiry' = DelayExpired,
   * 'floor' = a recall would have stranded 0 < debt < dMin, so the call repaid all and
   * collateral covered the remainder (owner ruling 2026-10-04, debt floor).
   */
  saleReason: SaleReason | null
  timeToBreachSeconds: number | null
  /** Null when no timer armed; always null for the no-delay class. */
  timeToArmSeconds: number | null
  timeToSaleSeconds: number | null
  /** Recall that would hold the LTV at the line through the trough with nothing sold. Null for levered_long. */
  recallNeededUsd: number | null
  /** The venue stock: min(deployed, exit capacity × multiplier). Null for levered_long. */
  recallAvailableUsd: number | null
  /** What the recalls actually drew (each call asks only for the restore-to-borrow-LTV
   *  amount, capped by the stock). Null for levered_long. */
  recallDrawnUsd: number | null
  /** Seconds from t0 when the venue first answers (after a freeze). Null if never needed / levered_long. */
  recallOpensAtSeconds: number | null
  horizonSeconds: number
}

export type StressResult = StressModelled | StressNotModelled

/** Rank of a result on STRESS_SEVERITY; -1 for not_modelled. */
export function stressRank(r: StressResult): number {
  return r.outcome === 'not_modelled' ? -1 : STRESS_SEVERITY[r.outcome]
}

// ------------------------------------------------------------ normalization

type NormPrice =
  | { kind: 'step'; drop: number }
  | { kind: 'linear'; drop: number; hours: number }
  | { kind: 'wick'; drop: number; hours: number; recover: number }
  | { kind: 'replay'; id: string; ratios: number[] }

interface NormalizedStress {
  pos: {
    c: number
    d: number
    line: number
    cls: MembraneClass
    shape: TradeShape
    dep: number
    /** Resolved exit capacity, USD. Null = a carry position with deployed capital gave
     *  none (not modelled: 'no_exit_capacity'). NaN = an invalid input or unknown preset. */
    cap: number | null
    /** The exit-capacity preset's measured lock, hours: no recall for this long from the
     *  first breach. 0 without a preset (or when `exitCapacityUsd` wins). */
    lock: number
    dMin: number
  }
  price: NormPrice
  /** `exit`: the scenario's absolute exit-capacity preset (`VenueStress.exitCapacityPreset`);
   *  the key only when set. Its capacity and lock are already resolved into `pos`. */
  venue: { mult: number; freezeHours: number; exit?: string }
  stepSeconds: number
}

/** Round to `dp` decimals; non-finite stays NaN, -0 becomes 0. */
function q(x: number, dp: number): number {
  if (!Number.isFinite(x)) return NaN
  const f = 10 ** dp
  const v = Math.round(x * f) / f
  return v === 0 ? 0 : v
}

const usd = (x: number) => q(x, 2)
const frac = (x: number) => q(x, 6)
const hrs = (x: number) => q(x, 4)

/** Forward-fill gaps, rebase on the first observation, round. Empty if nothing is usable. */
function normalizeReplay(ratios: readonly (number | null)[]): number[] {
  const first = ratios.find((r) => r != null && Number.isFinite(r) && r > 0)
  if (first == null) return []
  let last = first
  return ratios.map((r) => {
    if (r != null && Number.isFinite(r) && r > 0) last = r
    return q(last / first, 8)
  })
}

function normalizePrice(p: PriceShape): NormPrice {
  switch (p.kind) {
    case 'step':
      return { kind: 'step', drop: frac(p.drop) }
    case 'linear':
      return { kind: 'linear', drop: frac(p.drop), hours: hrs(p.hours) }
    case 'wick':
      return {
        kind: 'wick',
        drop: frac(p.drop),
        hours: hrs(p.hours),
        recover: frac(p.recover ?? 1),
      }
    case 'replay':
      return { kind: 'replay', id: String(p.id), ratios: normalizeReplay(p.ratios) }
  }
}

function normalize(
  position: StressPosition,
  scenario: StressScenario,
  opts: StressRunOptions,
): NormalizedStress {
  const carry = position.tradeShape === 'carry'
  const dep = carry ? usd(Math.max(0, position.deployedUsd ?? 0)) : 0
  // Ruling 5: no silent "everything deployed is withdrawable" default. An explicit USD
  // figure wins; else a named preset (or a custom multiple) resolves against the deployed
  // amount; else, with capital deployed, the capacity is MISSING (null) and the node is
  // not modelled.
  const preset = position.exitCapacityPreset
  // A named preset, else a custom multiple of the deployed amount (both resolve the same
  // way). A non-finite or negative custom multiple is NaN: validate() reads it as invalid.
  const customMult = position.exitCapacityMult
  const known =
    preset !== undefined && Object.prototype.hasOwnProperty.call(EXIT_CAPACITY_PRESETS, preset)
  const presetMult =
    preset !== undefined
      ? known
        ? EXIT_CAPACITY_PRESETS[preset].mult
        : NaN
      : customMult !== undefined
        ? Number.isFinite(customMult) && customMult >= 0
          ? customMult
          : NaN
        : undefined
  // The scenario's absolute venue level, when it names a known one, replaces whatever the
  // position chose (capacity AND lock). An unknown id leaves the position's own resolution
  // and is rejected by validate() ('invalid_venue').
  const venueExit = scenario.venue?.exitCapacityPreset
  const exitPreset =
    venueExit !== undefined &&
    Object.prototype.hasOwnProperty.call(EXIT_CAPACITY_PRESETS, venueExit)
      ? EXIT_CAPACITY_PRESETS[venueExit]
      : null
  const cap: number | null = !carry
    ? 0
    : exitPreset
      ? usd(dep * exitPreset.mult)
      : position.exitCapacityUsd !== undefined
        ? usd(Math.max(0, position.exitCapacityUsd))
        : presetMult !== undefined
          ? usd(dep * presetMult)
          : dep > 0
            ? null
            : 0
  // A preset's measured lock applies only when the preset resolves the capacity.
  const lock = !carry
    ? 0
    : exitPreset
      ? hrs(exitPreset.freezeHours)
      : position.exitCapacityUsd === undefined && known
        ? hrs(EXIT_CAPACITY_PRESETS[preset!].freezeHours)
        : 0
  const stepSeconds =
    scenario.price.kind === 'replay'
      ? q(scenario.price.stepSeconds, 3)
      : q(opts.stepSeconds ?? STRESS_DEFAULT_STEP_SECONDS, 3)
  return {
    pos: {
      c: usd(position.collateralUsd),
      d: usd(position.debtUsd),
      line: frac(position.line),
      cls: position.membraneClass,
      shape: position.tradeShape,
      dep,
      cap,
      lock,
      dMin: usd(Math.max(0, position.debtMinimumUsd ?? LIQ_DEBT_MINIMUM_USD)),
    },
    price: normalizePrice(scenario.price),
    venue: {
      mult: frac(scenario.venue?.capacityMult ?? 1),
      freezeHours: hrs(scenario.venue?.freezeHours ?? 0),
      // Written only when set: a scenario without it keeps its key byte for byte.
      ...(venueExit !== undefined ? { exit: String(venueExit) } : {}),
    },
    stepSeconds,
  }
}

function validate(n: NormalizedStress): NotModelledReason | null {
  const { pos, price, venue } = n
  const fin = Number.isFinite
  if (!(fin(pos.c) && pos.c > 0) || !(fin(pos.d) && pos.d >= 0)) return 'invalid_position'
  if (pos.cap === null) return 'no_exit_capacity'
  if (!fin(pos.dep) || !fin(pos.cap) || !fin(pos.dMin) || !(pos.lock >= 0)) {
    return 'invalid_position'
  }
  const params = MEMBRANE_CLASS_PARAMS[pos.cls]
  if (!params) return 'invalid_position'
  if (!(pos.line > 0 && pos.line <= params.ltvCeiling)) return 'line_out_of_class_range'
  if (!(fin(n.stepSeconds) && n.stepSeconds > 0)) return 'invalid_shape'
  if (price.kind === 'replay') {
    if (price.ratios.length < 2) return 'invalid_shape'
  } else {
    if (!(price.drop >= 0 && price.drop < 1)) return 'invalid_shape'
    if (price.kind !== 'step' && !(price.hours > 0)) return 'invalid_shape'
    if (price.kind === 'wick' && !(price.recover >= 0 && price.recover <= 1)) return 'invalid_shape'
  }
  if (!(venue.mult >= 0) || !(venue.freezeHours >= 0)) return 'invalid_venue'
  if (
    venue.exit !== undefined &&
    !Object.prototype.hasOwnProperty.call(EXIT_CAPACITY_PRESETS, venue.exit)
  ) {
    return 'invalid_venue'
  }
  if (
    pos.shape === 'levered_long' &&
    (venue.mult !== 1 || venue.freezeHours > 0 || venue.exit !== undefined)
  ) {
    return 'no_recall_levered_long'
  }
  return null
}

// --------------------------------------------------------------- cell key

/** JSON with object keys sorted at every depth. NaN/Infinity serialize as null. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

/** 64-bit string hash (two 32-bit lanes, cyrb53 mixing), as 16 hex chars. Deterministic. */
function hash64(s: string): string {
  let h1 = 0xdeadbeef
  let h2 = 0x41c6ce57
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i)
    h1 = Math.imul(h1 ^ ch, 2654435761)
    h2 = Math.imul(h2 ^ ch, 1597334677)
  }
  h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909)
  h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909)
  return (h2 >>> 0).toString(16).padStart(8, '0') + (h1 >>> 0).toString(16).padStart(8, '0')
}

/** The exact string a cell key hashes. Exported for reproducibility audits. */
export function stressCellCanonical(
  position: StressPosition,
  scenario: StressScenario,
  opts: StressRunOptions = {},
): string {
  return canonicalOf(normalize(position, scenario, opts))
}

function canonicalOf(n: NormalizedStress): string {
  const price =
    n.price.kind === 'replay'
      ? {
          kind: 'replay',
          id: n.price.id,
          n: n.price.ratios.length,
          digest: hash64(n.price.ratios.join(',')),
        }
      : n.price
  return stableStringify({
    v: STRESS_CODE_VERSION,
    pos: n.pos,
    price,
    venue: n.venue,
    step: n.stepSeconds,
  })
}

const pctId = (x: number) => String(q(x * 100, 4))

function scenarioIdOf(n: NormalizedStress): string {
  const p = n.price
  const base =
    p.kind === 'step'
      ? `step-${pctId(p.drop)}`
      : p.kind === 'linear'
        ? `linear-${pctId(p.drop)}-${p.hours}h`
        : p.kind === 'wick'
          ? `wick-${pctId(p.drop)}-${p.hours}h${p.recover === 1 ? '' : `-rec${pctId(p.recover)}`}`
          : `replay-${p.id}`
  const exit = n.venue.exit !== undefined ? `@exit-${n.venue.exit}` : ''
  const cap = n.venue.mult === 1 ? '' : `@cap-x${n.venue.mult}`
  const freeze = n.venue.freezeHours > 0 ? `@freeze-${n.venue.freezeHours}h` : ''
  return base + exit + cap + freeze
}

/** A scenario's machine id, e.g. 'step-25', 'wick-25-4h@cap-x0.1', 'linear-25-24h@freeze-8h',
 *  'step-25@exit-aave-usdc-floor-typical'. */
export function stressScenarioId(scenario: StressScenario, opts: StressRunOptions = {}): string {
  const probe: StressPosition = {
    collateralUsd: 1,
    debtUsd: 0,
    line: 0.5,
    membraneClass: 'delayed',
    tradeShape: 'carry',
  }
  return scenarioIdOf(normalize(probe, scenario, opts))
}

// ------------------------------------------------------------------- walk

/**
 * Half the resolution the key keeps on hours (`hrs`: 1e-4 h = 0.36 s). A normalized
 * duration is only known to ±0.18 s, so a hold that lands within that of a step boundary
 * is ON the boundary: a 60 s wick normalizes to 0.0167 h = 60.12 s and must stay ONE step.
 */
const HOURS_KEY_SLACK_S = (3600 * 1e-4) / 2

/** The ratio path: the shape, then the last value held for one window plus a step. */
function ratioPath(n: NormalizedStress): number[] {
  const step = n.stepSeconds
  const steps = (h: number) => Math.max(1, Math.round((h * 3600) / step))
  // A wick's HOLD rounds UP: rounding it down can end the trough before an armed timer's
  // expiry step and hand a free cure to a wick that outlasts the window (8h 25 s on a
  // 60 s grid read as 480 steps = exactly 8 h). Never shorter than the wick.
  const holdSteps = (h: number) => Math.max(1, Math.ceil((h * 3600 - HOURS_KEY_SLACK_S) / step))
  const p = n.price
  let path: number[]
  switch (p.kind) {
    case 'step':
      path = [1, 1 - p.drop]
      break
    case 'linear': {
      const m = steps(p.hours)
      path = Array.from({ length: m + 1 }, (_, i) => 1 - (p.drop * i) / m)
      break
    }
    case 'wick': {
      const b = holdSteps(p.hours)
      path = [1, ...new Array<number>(b).fill(1 - p.drop), 1 - p.drop * (1 - p.recover)]
      break
    }
    case 'replay':
      path = p.ratios.slice()
      break
  }
  const window = MEMBRANE_CLASS_PARAMS[n.pos.cls].windowSeconds
  const tail = (window > 0 ? Math.ceil(window / step) : 0) + 1
  const last = path[path.length - 1]
  for (let k = 0; k < tail; k++) path.push(last)
  return path
}

/** Why a sale ran — see `StressModelled.saleReason`. */
export type SaleReason = 'band' | 'expiry' | 'floor'

interface Walk {
  outcome: StressModelled['outcome']
  peakLtv: number
  landingLtv: number | null
  exposedUsd: number
  soldShare: number
  closedUsd: number
  badDebtUsd: number
  sales: number
  armed: boolean
  saleReason: SaleReason | null
  breachAt: number | null
  armAt: number | null
  saleAt: number | null
  /** A sale call whose recall covered the whole target: nothing sold, left over the line. */
  recallLiquidated: boolean
  recallStockUsd: number
  recallDrawnUsd: number
  recallOpensAt: number | null
}

function walk(n: NormalizedStress, ratios: readonly number[]): Walk {
  const { pos } = n
  const params = MEMBRANE_CLASS_PARAMS[pos.cls]
  const line = pos.line
  const cap = Math.max(0, line - params.borrowLtvGap)
  const delaySteps =
    params.windowSeconds > 0 ? Math.max(1, Math.ceil(params.windowSeconds / n.stepSeconds)) : 1
  // The SAME classifier cureWalk and compare.ts run (curePath.ts). band 0 ⇒ never arms.
  const timer = new DelayTimer({ line, band: params.band, delaySteps })
  const stock = pos.shape === 'carry' ? Math.min(pos.dep, (pos.cap ?? 0) * n.venue.mult) : 0
  // The scenario's freeze and the preset's measured lock both start at the first breach:
  // the venue answers once both are over.
  const freezeSteps = Math.ceil((Math.max(n.venue.freezeHours, pos.lock) * 3600) / n.stepSeconds)

  let debt = pos.d
  let collBase = pos.c // collateral on the t0 basis: value at step i = collBase × ratios[i]
  let drawn = 0
  let exposed = 0
  let soldBase = 0 // collateral sold, on the t0 basis (units × t0 price)
  let closed = 0
  let sales = 0
  let recallCures = 0
  let recallLiquidated = false
  let armed = false
  let breachAt: number | null = null
  let armAt: number | null = null
  let saleAt: number | null = null
  let saleReason: SaleReason | null = null
  let peak = debt / collBase

  for (let i = 0; i < ratios.length; i++) {
    const r = ratios[i]
    const coll = collBase * r
    if (!(debt > DUST_USD)) continue // nothing owed: nothing can breach
    if (!(coll > DUST_USD)) {
      // Collateral worth (next to) nothing with debt owed: the LTV is unbounded — a
      // breach, past every threshold. A keeper's call recalls first; whatever the recall
      // leaves takes the SALE path (Immediate / BrokeWindow) on a full-debt target
      // (L >= 1, LE:2673-2688), the remaining collateral goes, and the uncovered rest is
      // bad debt (LE:2361-2374). Breaking out before this read a total wipe-out — the
      // worst node on the grid — as `no_breach`.
      // Sold out by an earlier call: that call already settled the remainder as bad debt.
      if (!(collBase > 0)) break
      // This IS the walk's highest LTV: unbounded at $0 of collateral, enormous near it.
      // (It used to skip the peak update, so a replay to 1e-10 reported its pre-crash
      // peak while one to 1e-5 — just above the dust line — reported 70,000.)
      const ltvWipe = coll > 0 ? debt / coll : Infinity
      if (ltvWipe > peak) peak = ltvWipe
      if (breachAt === null) breachAt = i
      const open = i >= breachAt + freezeSteps
      // Ruling 2: ask only the restore-to-borrow-LTV amount. With (next to) no collateral
      // that is (next to) the whole debt.
      const ask = membraneRecallTarget(debt, coll, cap, pos.dMin)
      const recall = open ? Math.min(ask, Math.max(0, stock - drawn)) : 0
      drawn += recall
      closed += recall
      debt -= recall
      if (!(debt > DUST_USD)) {
        // The recall repaid the whole debt: the recall-only lane (LE:1623-1658).
        recallCures++
        timer.clearAfterSale()
        continue
      }
      const seized = Math.max(0, coll)
      sales++
      exposed += seized
      soldBase += collBase
      closed += seized
      debt -= seized
      collBase = 0
      if (saleAt === null) {
        saleAt = i
        saleReason = 'band'
      }
      break
    }
    const ltvPre = debt / coll
    if (ltvPre > peak) peak = ltvPre

    if (ltvPre <= line) {
      timer.step(i, ltvPre) // 'none', or 'save' (SavedByDelay) when a timer runs
      continue
    }

    // Over the line: a keeper calls. Step 1.5 recalls first. Ruling 2 (owner 2026-10-04):
    // the ask is only what restores the borrow LTV (master asks for the FULL debt, LE:1320).
    if (breachAt === null) breachAt = i
    const open = i >= breachAt + freezeSteps
    const ask = membraneRecallTarget(debt, coll, cap, pos.dMin)
    const recall = open ? Math.min(ask, Math.max(0, stock - drawn)) : 0
    const ltvPost = (debt - recall) / coll
    // Ruling 1 on the ARRIVAL: the ask carries the remainder guard, but a venue short of
    // an ask already escalated to the whole loan can still strand 0 < debt < dMin.
    const floorRest = recall > 0 ? debtFloorRemainder(debt, recall, pos.dMin) : 0
    const recallOnly = recall > 0 && ltvPost <= line

    if (recallOnly && !(floorRest > 0)) {
      // Recall-only lane (LE:1623-1658): commits, clears any timer, never arms one.
      drawn += recall
      closed += recall
      debt -= recall
      recallCures++
      timer.clearAfterSale()
      continue
    }

    const act = recallOnly ? null : timer.step(i, ltvPost)
    if (floorRest > 0 && (act === null || act.kind === 'arm')) {
      // A call that would COMMIT this recall (recall-only cure, or TimerStarted) and leave
      // sub-floor debt repays ALL instead (owner ruling 2026-10-04): the venue is already
      // short, so collateral sells the remainder and the loan closes — no cure, no window.
      // Master commits the recall and leaves the dust (LE:1623-1658, no floor).
      const seized = Math.min(floorRest, coll)
      drawn += recall
      closed += recall + seized
      debt -= recall + seized
      collBase = (coll - seized) / r
      timer.clearAfterSale()
      if (seized > 0) {
        sales++
        exposed += seized
        soldBase += seized / r
        if (saleAt === null) {
          saleAt = i
          saleReason = 'floor'
        }
      }
      if (sales >= MAX_STRESS_SALES) break
      continue
    }
    if (act === null) continue // unreachable: a recall-only call with no floor rest cured above
    if (act.kind === 'arm') {
      // TimerStarted: the timer-only exit returns normally, so the recall COMMITS.
      drawn += recall
      closed += recall
      debt -= recall
      armed = true
      if (armAt === null) armAt = i
      continue
    }
    // 'hold': TimerActive reverts (LE:1690) and rolls this call's recall back.
    if (act.kind !== 'sell') continue

    // Immediate / BrokeWindow / DelayExpired. Target: PRE-recall debt at POST-recall LTV.
    // Ruling 1 on the whole call: it repays at least what the recall brought, and the
    // remainder guard runs on that total, so a recall past the formula target that would
    // strand 0 < debt < dMin sells the remainder rather than leaving it.
    const target = applyDebtMinimum(
      Math.max(membraneRepayValue(debt, debt / ltvPost, cap, pos.dMin), recall),
      debt,
      pos.dMin,
    )
    const seized = Math.min(Math.max(0, target - recall), coll)
    drawn += recall
    closed += recall + seized
    debt -= recall + seized
    collBase = (coll - seized) / r
    // The recall covered the whole target: the call committed, the timer (if any) was
    // cleared on the sale path, and the position is still over the line. Not a cure.
    if (!(seized > 0)) recallLiquidated = true
    if (seized > 0) {
      sales++
      exposed += seized
      soldBase += seized / r
      if (saleAt === null) {
        saleAt = i
        saleReason = act.reason
      }
    }
    if (sales >= MAX_STRESS_SALES) break
  }

  const collEnd = collBase * ratios[ratios.length - 1]
  const owed = debt > DUST_USD
  const landingLtv = !owed ? 0 : collEnd > DUST_USD ? debt / collEnd : null
  // The most severe thing that happened (STRESS_SEVERITY order).
  const outcome: Walk['outcome'] =
    sales > 0
      ? 'sold'
      : recallLiquidated
        ? 'recall_liquidated'
        : armed
          ? 'armed_cured'
          : recallCures > 0 || breachAt !== null
            ? 'recall_cured'
            : 'no_breach'

  return {
    outcome,
    peakLtv: peak,
    landingLtv,
    exposedUsd: exposed,
    soldShare: Math.min(1, soldBase / pos.c),
    closedUsd: closed,
    badDebtUsd: owed && !(collEnd > DUST_USD) ? debt : 0,
    sales,
    armed,
    saleReason,
    breachAt,
    armAt,
    saleAt,
    recallLiquidated,
    recallStockUsd: stock,
    recallDrawnUsd: drawn,
    recallOpensAt: breachAt === null ? null : breachAt + freezeSteps,
  }
}

// ------------------------------------------------------------------ run

/** Run ONE scenario against ONE position. Pure and deterministic. */
export function runStress(
  position: StressPosition,
  scenario: StressScenario,
  opts: StressRunOptions = {},
): StressResult {
  const n = normalize(position, scenario, opts)
  const base: StressResultBase = {
    cellKey: `sg-${hash64(canonicalOf(n))}`,
    codeVersion: STRESS_CODE_VERSION,
    label: STRESS_LABEL,
    scenarioId: scenarioIdOf(n),
  }
  const reason = validate(n)
  if (reason) return { ...base, outcome: 'not_modelled', reason }

  const ratios = ratioPath(n)
  const w = walk(n, ratios)
  const params = MEMBRANE_CLASS_PARAMS[n.pos.cls]
  const carry = n.pos.shape === 'carry'
  const secs = (i: number | null) => (i === null ? null : i * n.stepSeconds)
  // A loop, not Math.min(...ratios): spreading a long path (~120k+ points) overflows the stack.
  let minRatio = Infinity
  for (const x of ratios) if (x < minRatio) minRatio = x

  return {
    ...base,
    outcome: w.outcome,
    membraneClass: n.pos.cls,
    tradeShape: n.pos.shape,
    startLtv: n.pos.d / n.pos.c,
    line: n.pos.line,
    breakLine: n.pos.line * (1 + params.band),
    peakLtv: w.peakLtv,
    landingLtv: w.landingLtv,
    exposedUsd: w.exposedUsd,
    soldShare: w.soldShare,
    closedUsd: w.closedUsd,
    badDebtUsd: w.badDebtUsd,
    sales: w.sales,
    armed: w.armed,
    saleReason: w.saleReason,
    timeToBreachSeconds: secs(w.breachAt),
    timeToArmSeconds: secs(w.armAt),
    timeToSaleSeconds: secs(w.saleAt),
    recallNeededUsd: carry ? Math.max(0, n.pos.d - n.pos.line * n.pos.c * minRatio) : null,
    recallAvailableUsd: carry ? w.recallStockUsd : null,
    recallDrawnUsd: carry ? w.recallDrawnUsd : null,
    recallOpensAtSeconds: carry ? secs(w.recallOpensAt) : null,
    horizonSeconds: (ratios.length - 1) * n.stepSeconds,
  }
}

// ------------------------------------------------------------------ grid

/** Week-1 price shapes (RISK_FRONTIER_DESIGN.md §7). Data, so the UI can change it. */
export const DEFAULT_PRICE_SHAPES: readonly PriceShape[] = [
  { kind: 'step', drop: 0.1 },
  { kind: 'step', drop: 0.25 },
  { kind: 'step', drop: 0.5 },
  { kind: 'linear', drop: 0.25, hours: 24 },
  { kind: 'wick', drop: 0.25, hours: 4 },
]

/** Venue exit capacity multipliers, applied to the position's EXPLICIT exit capacity
 *  (`exitCapacityUsd` / `exitCapacityPreset` / `exitCapacityMult`). ×1 is the baseline row —
 *  the capacity the caller chose, not "everything deployed". The cuts are MEASURED, not named:
 *  EXIT_CAPACITY_DEFAULT_CUTS (the default venue's bad event and its everyone-exits floor, as
 *  multiples of the default preset). Distinct, largest first. */
export const DEFAULT_CAPACITY_MULTS: readonly number[] = [
  ...new Set([1, ...EXIT_CAPACITY_DEFAULT_CUTS.map((c) => c.mult).filter((m) => m < 1)]),
].sort((a, b) => b - a)

/** Venue freeze lengths, hours. */
export const DEFAULT_FREEZE_HOURS: readonly number[] = [4, 8, 24]

export interface StressGridOptions extends StressRunOptions {
  /** Price shapes. Add an Oct-10 replay with oct10ReplayShape. */
  shapes?: readonly PriceShape[]
  capacityMults?: readonly number[]
  freezeHours?: readonly number[]
}

export interface StressCell {
  scenario: StressScenario
  result: StressResult
}

/**
 * The grid's scenarios: every price shape × every venue condition. Venue conditions are
 * single-axis (a capacity multiplier OR a freeze), never combined; a levered_long position
 * gets the baseline row only — it has no recall rows.
 */
export function stressGridScenarios(
  tradeShape: TradeShape,
  opts: StressGridOptions = {},
): StressScenario[] {
  const shapes = opts.shapes ?? DEFAULT_PRICE_SHAPES
  const venues: (VenueStress | undefined)[] =
    tradeShape === 'levered_long'
      ? [undefined]
      : [
          ...(opts.capacityMults ?? DEFAULT_CAPACITY_MULTS).map((m) =>
            m === 1 ? undefined : { capacityMult: m },
          ),
          ...(opts.freezeHours ?? DEFAULT_FREEZE_HOURS).map((h) => ({ freezeHours: h })),
        ]
  return shapes.flatMap((price) => venues.map((venue) => (venue ? { price, venue } : { price })))
}

/** Run the whole grid for one position. */
export function runStressGrid(
  position: StressPosition,
  opts: StressGridOptions = {},
): StressCell[] {
  return stressGridScenarios(position.tradeShape, opts).map((scenario) => ({
    scenario,
    result: runStress(position, scenario, opts),
  }))
}

// -------------------------------------------------------------- inputs

/**
 * The Oct 10 2025 path for a collateral symbol, RELATIVE to its first observation in
 * [fromIndex, toIndex] — the crash's shape, not its price level. Uses the ORACLE column
 * (scenario.ts SYMBOL_TO_SERIES). Null for a symbol with no measured series (stables held
 * at $1 included): the caller must show that as not modelled, never as flat.
 */
export function oct10ReplayShape(
  series: Oct10Series,
  symbol: string,
  opts: { fromIndex?: number; toIndex?: number } = {},
): PriceShape | null {
  const column = SYMBOL_TO_SERIES[symbol]
  const col = column ? series.columns[column] : undefined
  if (!col || col.length < 2) return null
  const from = Math.max(0, Math.floor(opts.fromIndex ?? 0))
  const to = Math.min(col.length - 1, Math.floor(opts.toIndex ?? col.length - 1))
  if (to - from < 1) return null
  const slice = col.slice(from, to + 1)
  if (!slice.some((v) => v != null && v > 0)) return null
  return {
    kind: 'replay',
    id: `oct10-2025:${column}:${from}-${to}`,
    stepSeconds: series.stepSeconds,
    ratios: slice,
  }
}

export type StressPositionFromProtocol =
  | { ok: true; position: StressPosition }
  | { ok: false; reason: 'mixed_class' | 'no_line'; symbols: string[] }

/**
 * A scalar stress position from a real (imported) lending position, using the task-#1
 * class table. A basket mixing classes is refused, as master refuses it
 * (MixedDelayClassCollateral, Collateral.sol:510-514). A leg with no Membrane line is
 * refused unless the caller supplies a line.
 */
export function stressPositionFromProtocol(
  p: ProtocolPosition,
  opts: {
    tradeShape: TradeShape
    deployedUsd?: number
    exitCapacityUsd?: number
    exitCapacityPreset?: ExitCapacityPresetId
    line?: number
    debtMinimumUsd?: number
  },
): StressPositionFromProtocol {
  const derived = weightedMembraneLine(p.collateral)
  if (derived.mixed) return { ok: false, reason: 'mixed_class', symbols: [] }
  if (opts.line === undefined && derived.unknown.length > 0) {
    return { ok: false, reason: 'no_line', symbols: derived.unknown }
  }
  return {
    ok: true,
    position: {
      collateralUsd: p.totalCollateralUsd,
      debtUsd: p.totalDebtUsd,
      line: opts.line ?? derived.maxLtv,
      membraneClass: derived.class === 'no-delay' ? 'no-delay' : 'delayed',
      tradeShape: opts.tradeShape,
      deployedUsd: opts.deployedUsd,
      exitCapacityUsd: opts.exitCapacityUsd,
      exitCapacityPreset: opts.exitCapacityPreset,
      debtMinimumUsd: opts.debtMinimumUsd,
    },
  }
}
