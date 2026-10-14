/**
 * cureWalk — the 8-hour delay window, modelled minute by minute against a real price
 * path, exactly as LiquidationEngine.sol classifies a call.
 *
 * ONE implementation, shared by the Oct-10 census (scripts/build-evidence.ts) and the
 * per-address simulator (lib/position-sim/compare.ts). The shared piece is the
 * `DelayTimer` state machine below: `cureWalk` wraps it for a scalar position with a
 * ratio series, and `compare.ts` drives the SAME machine over multi-leg per-minute
 * prices with venue recall and a liquidation fee layered on top. Both therefore agree
 * on WHEN a sale happens; scripts/tests/position-sim.test.ts asserts that on two real
 * census accounts.
 *
 * ---------------------------------------------------------------------------
 * CONTRACT TRUTH (membrane-solidity, read 2026-09-14)
 * ---------------------------------------------------------------------------
 * (i)   DELAY LENGTH. `liquidationDelay` is a constructor/timelock parameter
 *       (LiquidationEngine.sol:453, :588-595, :814-819). It has no compiled-in
 *       default on the Solidity side; the Rust source it ports sets 28,800 s
 *       (liquidation-engine/src/contract.rs:52, `unwrap_or(28800)`), which is the
 *       value `CURE_WINDOW_SECONDS` carries. Timer arithmetic is
 *       `startTime + liquidationDelay` (LiquidationEngine.sol:839, :1348-1349).
 *
 * (ii)  THE BAND TEST IS MULTIPLICATIVE, AGAINST THE LIQUIDATION LINE.
 *       `_immediateThreshold(avgMaxLtv, avgMaxThresholdToDelay)
 *          = avgMaxLtv + band * avgMaxLtv / 1e18`   (LiquidationEngine.sol:2099-2103)
 *       so the break line is `line * (1 + band)`, NOT `line + band`. The test is
 *       strict: `aboveThreshold = currentLtv > threshold` (LiquidationEngine.sol:1329).
 *       `band` is the per-asset `max_threshold_to_delay` (Collateral.sol:48; the
 *       deploy scripts stamp 4e16 on every launch asset, and the only path that
 *       stamps anything else is permissionless onboarding at 95e16,
 *       Collateral.sol:208-210), averaged by collateral value across the basket.
 *
 * (iii) RECOVERY CLEARS THE TIMER, SO A LATER BREACH RE-ARMS.
 *       `if (hasTimer && !aboveThreshold && currentLtv <= avgMaxLtv)` deletes the
 *       timer and records `SavedByDelay` (LiquidationEngine.sol:1362-1382); the
 *       permissionless `saveByDelay` entrypoint does the same and requires
 *       `currentLtv <= avgMaxLtv` (LiquidationEngine.sol:760-781). A fresh breach
 *       afterwards therefore classifies as `TimerStarted` and gets a FULL new delay
 *       (LiquidationEngine.sol:1388-1419). The delay is NOT one-shot.
 *
 *       AMBIGUITY, stated and now PRICED: both clearing paths are permissionless and
 *       cost only gas, but somebody must call them. A recovery that nobody reports
 *       leaves the timer armed and its original expiry standing. Instant clearing is
 *       the modelled semantics here (`noEarlyClear: false`, the default). The opposite
 *       corner — a timer that is never cleared early, whose expiry stands, and which a
 *       later breach does not restart — is `noEarlyClear: true`, and the census
 *       publishes it as `meta.sensitivity.noEarlyClearMembraneClosedUsd`.
 *       Recovery only re-arms on a return under the LINE (`<= line`), never merely
 *       back inside the band, because that is the exact predicate both contract paths
 *       require. (The contract also has a stale-timer amnesty at 2x delay,
 *       LiquidationEngine.sol:1343-1347; it cannot bind here because this model
 *       always resolves a timer at or before its own expiry.)
 *
 * (iv)  AT EXPIRY, STILL OVER THE LINE -> SALE. `timerExpired` (:1348) with
 *       `!aboveThreshold` classifies `DelayExpired` (:1391-1392) and falls through
 *       to the liquidation body; the timer is cleared (:1421-1423). The sale is the
 *       partial repay-to-cap, `membraneRepayValue` — the Solidity partial-liquidation
 *       formula (LiquidationEngine.sol:2204-2238) sized against the borrow cap
 *       `line - BORROW_LTV_GAP`, priced at that minute's collateral value, and then
 *       pushed through the `liqDebtMinimum` floor and remainder guard
 *       (LiquidationEngine.sol:2241-2269, see `applyDebtMinimum`).
 *
 * (v)   BAND BROKEN DURING THE DELAY -> IMMEDIATE SALE. `aboveThreshold && hasTimer`
 *       classifies `BrokeWindow` (:1388-1389); the timer is cleared (:1421-1423) and
 *       the same partial repay runs at once. A breach that is already past the band
 *       with no timer is `Immediate` (:1390) — also an immediate sale, never a
 *       delay. So the band is the guarantee and the 8 hours are conditional on it.
 *
 * (vi)  A SALE RE-ARMS. The repay restores the BORROW cap, not zero, and the timer is
 *       deleted (:1421-1423). The position is therefore live afterwards: a later
 *       price move can breach it again and open a FULL fresh delay, and a later band
 *       break can sell again. The walk carries the reduced debt and collateral
 *       forward and keeps going, capped at `maxSales` sales.
 *
 * (vii) THE NO-DELAY CLASS, AND THE PAID RECALL-ONLY LANE. (Cited at membrane-solidity
 *       master 16e12329; clauses (i)-(vi) cite the 2026-09-14 read and its line numbers.)
 *       A listing whose immutable `max_ltv_cap` is above MAX_LTV_HARD_CAP (90%) is in the
 *       NO-DELAY class (`_noDelay`, Collateral.sol:424-426) and must carry
 *       `max_threshold_to_delay == 0` (Collateral.sol:430-432). The engine then runs in
 *       instant mode: `p.instantMode = _instantMode[key] || (address(v) != address(0) &&
 *       p.avgMaxThresholdToDelay == 0)` (LiquidationEngine.sol:1572); the threshold IS the
 *       line and `aboveThreshold = currentLtv > threshold` (:1573-1576), which classifies
 *       `Immediate` (:1694-1703); a timer can never arm (`InstantModeNotLiquidatable`,
 *       :1708-1710). So a no-delay position is sold the minute its LTV is over the line
 *       (strict `>`), every time: no window, no band, no cure. The sale is the same
 *       repay-to-cap, and the position walks on and is sold again on a later breach.
 *       `noDelay` on DelayTimerOptions / CureWalkInput selects it; WHICH collateral is
 *       no-delay is collateralClass.ts's call (MODELLED: stable => no-delay listing, as the
 *       deploy lists sUSDS / syrupUSDC / scrvUSD). The classes never share a position
 *       (Cdp.sol:1650-1651, `MixedDelayClassCollateral`, Collateral.sol:789-793).
 *
 *       RECALL-ONLY LANE, both classes (LiquidationEngine.sol:1603-1658): when this call's
 *       Step 1.5 venue recall ALONE brings the position back to or under its line
 *       (:1623, `totalRepaid != 0 && currentLtv <= avgMaxLtv`), any timer is deleted,
 *       nothing is sold (the queue / sell-wall steps are skipped, :1137-1141), and the
 *       keeper is paid the ordinary Step-9 fee from the borrower's collateral (:1821-1838,
 *       :1877, :1887) on `min(restore-to-borrow-cap target, recalled)` (:1653-1654). It
 *       reverts if the position was not over its line BEFORE the recall (:1644). This
 *       timer does not model recall — compare.ts layers it on top; the census credits no
 *       recall at all.
 *
 * ---------------------------------------------------------------------------
 * PRICE INPUT
 * ---------------------------------------------------------------------------
 * `ratios[i]` is the COMPOSITE collateral ratio in debt units:
 *     ratios[i] = (collateralPrice[i] / collateralPrice[0]) / (debtPrice[i] / debtPrice[0])
 * so `collateralUsd * ratios[i]` is the collateral value at minute i with the debt
 * value held constant, and `ltv(i) = ltv0 / ratios[i]`. `ratios[0]` must be 1.
 * A `null` entry is a gap in the oracle grid: the last observed ratio is carried
 * forward (the clock keeps running through a gap — it is wall time, not tick time).
 */

import { membraneRepayValue } from './membrane'

export type CureOutcome =
  /** Never sold, never cured — reachable only if the position was never breached. */
  | 'held'
  /** Recovered under the line at least once and finished the grid not selling. */
  | 'cured-then-held'
  /** Sold because the LTV climbed past line x (1 + band) while a timer ran. */
  | 'sold-at-band'
  /** Sold because the delay ran out with the LTV still over the line. */
  | 'sold-at-expiry'
  /** Already past the band at t0 — no delay is ever granted. */
  | 'sold-at-t0'
  /**
   * NO-DELAY CLASS (clause vii): over the line at t0, sold at t0, and sold again at
   * every later minute the walk finds it back over the line. No window ever exists.
   */
  | 'sold-no-delay'
  /** The price grid ended inside an unresolved delay. Conservative: sell. */
  | 'sold-at-grid-end'
  /** No usable price series for this account: fall back to the one-repay figure. */
  | 'sold-immediately-no-series'
  /**
   * The account's inverted line puts it UNDER its own line at t0, so no breach can
   * be located and no window can be started. The census EXCLUDES these from both
   * sides of its totals (they are a state/event mismatch the data cannot resolve);
   * the figure returned here is the conservative one-repay-to-cap so the row can
   * still be shown.
   */
  | 'sold-immediately-unlocated-line'

// --------------------------------------------------------------- shared timer

/** What the delay state machine says to do at one minute. */
export type DelayAction =
  /** Healthy, nothing armed. */
  | { kind: 'none' }
  /** A breach inside the band opened a FULL fresh delay (TimerStarted, :1393-1419). */
  | { kind: 'arm' }
  /** A timer is running and protecting the position (TimerActive, :1385). */
  | { kind: 'hold' }
  /** Back under the line: the timer is deleted (SavedByDelay, :1362-1382). */
  | { kind: 'save' }
  /**
   * Sell now. `band` = BrokeWindow/Immediate (:1388-1390); `expiry` = DelayExpired;
   * `instant` = the no-delay class over its line (instant mode, clause vii).
   */
  | { kind: 'sell'; reason: SaleReason }

/** Why the timer said sell. */
export type SaleReason = 'band' | 'expiry' | 'instant'

export interface DelayTimerOptions {
  /** The liquidation line (max LTV) this position is judged against. */
  line: number
  /** `max_threshold_to_delay` — the band above the line that breaks the delay. */
  band: number
  /** Delay length expressed in grid steps. */
  delaySteps: number
  /**
   * Model the corner where nobody ever calls `clearRecoveredTimer` / `saveByDelay`:
   * a return under the line does NOT clear an armed timer, its original expiry
   * stands, and a later breach does not restart it. Default false.
   */
  noEarlyClear?: boolean
  /**
   * The NO-DELAY class (clause vii): the timer never arms. Over the line (strict `>`)
   * sells at once with reason `instant`; at or under it does nothing. `band` and
   * `delaySteps` are ignored. Default false.
   */
  noDelay?: boolean
}

/**
 * The minute-by-minute classifier both engines run. It owns ONLY the timer: it is
 * given an LTV and returns what the contract would classify. Sizing the repay,
 * recalling from venues and charging a fee are the caller's business.
 */
export class DelayTimer {
  readonly line: number
  readonly breakLine: number
  readonly delaySteps: number
  readonly noEarlyClear: boolean
  readonly noDelay: boolean

  /** Step index the running timer started at, or null when nothing is armed. */
  private startedAt: number | null = null
  /** No-delay only: the position is over its line and has not been sold since. */
  private overLine = false
  /** How many separate times the position crossed above its line. */
  breaches = 0
  /** First step index back under the line, or null. */
  firstCureIndex: number | null = null

  constructor(opts: DelayTimerOptions) {
    this.line = opts.line
    this.breakLine = opts.line * (1 + opts.band)
    this.delaySteps = Math.max(1, Math.round(opts.delaySteps))
    this.noEarlyClear = opts.noEarlyClear ?? false
    this.noDelay = opts.noDelay ?? false
  }

  get armed(): boolean {
    return this.startedAt !== null
  }

  /** The timer is deleted when a sale runs (LiquidationEngine.sol:1421-1423). */
  clearAfterSale(): void {
    this.startedAt = null
    this.overLine = false
  }

  step(i: number, ltv: number): DelayAction {
    if (this.noDelay) {
      // Instant mode (LiquidationEngine.sol:1572-1576): the threshold is the line itself
      // and nothing ever arms (:1708-1710). A breach is counted once per crossing — a
      // minute still over the line after a sale that could not run is the same breach.
      if (ltv > this.line) {
        if (!this.overLine) this.breaches++
        this.overLine = true
        return { kind: 'sell', reason: 'instant' }
      }
      this.overLine = false
      return { kind: 'none' }
    }
    if (this.startedAt !== null) {
      if (ltv <= this.line) {
        if (this.firstCureIndex === null) this.firstCureIndex = i
        if (!this.noEarlyClear) {
          this.startedAt = null
          return { kind: 'save' }
        }
        // Nobody called: the timer keeps running and its expiry still stands.
        if (i - this.startedAt >= this.delaySteps) {
          this.startedAt = null
          return { kind: 'sell', reason: 'expiry' }
        }
        return { kind: 'hold' }
      }
      if (ltv > this.breakLine) {
        this.startedAt = null
        return { kind: 'sell', reason: 'band' } // BrokeWindow (:1388-1389)
      }
      if (i - this.startedAt >= this.delaySteps) {
        this.startedAt = null
        return { kind: 'sell', reason: 'expiry' } // DelayExpired (:1391-1392)
      }
      return { kind: 'hold' } // TimerActive (:1385)
    }

    if (ltv > this.breakLine) {
      this.breaches++
      return { kind: 'sell', reason: 'band' } // Immediate (:1390)
    }
    if (ltv > this.line) {
      this.breaches++
      this.startedAt = i
      return { kind: 'arm' }
    }
    // NOT a cure: `firstCureIndex` records SavedByDelay only — a position back under
    // its line WHILE a timer runs. A position that is under its line because it was
    // just SOLD down to the borrow cap was not cured by anything.
    return { kind: 'none' }
  }
}

// ------------------------------------------------------------------ cureWalk

export interface CureWalkInput {
  /** Debt value at t0, USD. Held constant except where a sale reduces it. */
  debtUsd: number
  /** Collateral value at t0, USD. Scaled by `ratios[i]`. */
  collateralUsd: number
  /** The liquidation line (max LTV) this position is judged against. */
  line: number
  /** `max_threshold_to_delay` — the band above the line that breaks the delay. */
  band: number
  /** Delay window length in seconds. */
  delaySeconds: number
  /** Grid resolution in seconds (60 for the Oct-10 1-minute series). */
  stepSeconds: number
  /** The borrow/liquidation LTV gap the repay restores to. */
  gap: number
  /** Composite collateral/debt price ratios, index 0 == t0 == 1. Null = no series. */
  ratios: readonly (number | null)[] | null
  /** `liqDebtMinimum` in USD. 0 (the default) disables the floor. */
  debtMinimumUsd?: number
  /** Hard cap on how many sales one episode may run. Default 20. */
  maxSales?: number
  /** See DelayTimerOptions.noEarlyClear. Default false. */
  noEarlyClear?: boolean
  /**
   * The NO-DELAY class (clause vii). Breached at t0, the position is sold at t0 (the same
   * repay-to-cap and floor), then the walk goes on and sells again at every later minute
   * it is back over the line, up to `maxSales`. Outcome `sold-no-delay`; with no series,
   * one repay and `sold-immediately-no-series` as for any row. `band` is ignored.
   * Default false — the delayed class, unchanged.
   */
  noDelay?: boolean
  /**
   * EXECUTION BOUND, off by default. The contract's repay-to-cap is sized from the ORACLE
   * value of the collateral and assumes the sale clears at that price, so on an illiquid
   * leg it is an upper bound rather than a forecast. Set this to cap what ONE sale may
   * close, leaving the rest of the position to walk on and be sold again at a later
   * minute. Undefined (the default) leaves the repay uncapped, which is what the headline
   * census publishes; the capped run is published beside it as a sensitivity.
   */
  maxRepayPerSaleUsd?: number
}

export interface CureWalkResult {
  /** Debt value Membrane closes on this account across the whole path. */
  closedUsd: number
  /** Grid index of the FIRST sale, or null when nothing was sold. */
  closedAtIndex: number | null
  /** The outcome of the FIRST sale, or the terminal state when nothing was sold. */
  outcome: CureOutcome
  /** Minutes from t0 to the first minute back under the line, or null. */
  minutesToFirstCure: number | null
  /** How many separate times the position crossed above its line. */
  breaches: number
  /** How many separate sales ran. 0 when nothing was sold. */
  sales: number
}

const DEFAULT_MAX_SALES = 20

/**
 * Replay one position's delay window against a price path.
 *
 * The repay restores the BORROW cap, not zero, so a sale does not end the episode:
 * the reduced debt and collateral walk on and can breach again. Capped at
 * `maxSales` sales (default 20).
 */
export function cureWalk(input: CureWalkInput): CureWalkResult {
  const { debtUsd, collateralUsd, line, band, delaySeconds, stepSeconds, gap, ratios } = input
  const dMin = input.debtMinimumUsd ?? 0
  const maxSales = input.maxSales ?? DEFAULT_MAX_SALES
  /** Per-sale execution cap. Infinity (the default) is the uncapped headline behaviour. */
  const repayCap =
    input.maxRepayPerSaleUsd != null && input.maxRepayPerSaleUsd >= 0
      ? input.maxRepayPerSaleUsd
      : Infinity

  const cap = Math.max(0, line - gap)
  const oneRepay = Math.min(membraneRepayValue(debtUsd, collateralUsd, cap, dMin), repayCap)

  // --- t0 classification ---------------------------------------------------
  if (!(debtUsd > 0) || !(collateralUsd > 0)) {
    return {
      closedUsd: oneRepay,
      closedAtIndex: 0,
      outcome: 'sold-immediately-no-series',
      minutesToFirstCure: null,
      breaches: 0,
      sales: 1,
    }
  }

  const ltv0 = debtUsd / collateralUsd

  // Not breached at t0. The line was inverted from a health factor >= 1, so this
  // account sits under its own line in the snapshot and no window can be located.
  // The census EXCLUDES these rather than crediting them a free cure.
  if (ltv0 <= line) {
    return {
      closedUsd: oneRepay,
      closedAtIndex: 0,
      outcome: 'sold-immediately-unlocated-line',
      minutesToFirstCure: null,
      breaches: 0,
      sales: 1,
    }
  }

  const noDelay = input.noDelay ?? false
  const breakLine = line * (1 + band)

  // Past the band at t0: `Immediate` (LiquidationEngine.sol:1390). No delay exists.
  // (The no-delay class has no band: it is sold at t0 below and walks on.)
  if (!noDelay && ltv0 > breakLine) {
    return {
      closedUsd: oneRepay,
      closedAtIndex: 0,
      outcome: 'sold-at-t0',
      minutesToFirstCure: null,
      breaches: 1,
      sales: 1,
    }
  }

  // Inside the band but over the line (or no-delay and over the line), and we have
  // nothing to walk: fall back to the shipped figure rather than inventing a cure we
  // cannot observe.
  const usable = ratios && ratios.length > 1
  if (!usable) {
    return {
      closedUsd: oneRepay,
      closedAtIndex: 0,
      outcome: 'sold-immediately-no-series',
      minutesToFirstCure: null,
      breaches: 1,
      sales: 1,
    }
  }

  const series = ratios as readonly (number | null)[]
  const n = series.length
  const minutesPerStep = stepSeconds / 60
  // Ceil: the sale fires on the first grid point at or past `startTime + delay`.
  const delaySteps = Math.max(1, Math.ceil(delaySeconds / stepSeconds))

  const timer = new DelayTimer({
    line,
    band,
    delaySteps,
    noEarlyClear: input.noEarlyClear,
    noDelay,
  })

  /** Debt and collateral carried forward across sales. `collBase` is on the t0 basis:
   *  the value at minute i is `collBase * ratios[i]`. */
  let debt = debtUsd
  let collBase = collateralUsd
  let closed = 0
  let sales = 0
  let firstIndex: number | null = null
  let firstOutcome: CureOutcome | null = null
  let lastRatio = 1

  /** One sale at minute i, price ratio r. Returns false when the episode is over. */
  const sell = (i: number, r: number, reason: SaleReason): boolean => {
    const collAt = collBase * r
    let repaid = membraneRepayValue(debt, collAt, cap, dMin)
    if (repaid > repayCap) repaid = repayCap
    if (repaid > debt) repaid = debt
    if (!(repaid > 0)) return debt > 0 && collAt > 0 && sales < maxSales
    const seized = Math.min(repaid, collAt) // no liquidation fee in the census
    closed += repaid
    sales++
    if (firstIndex === null) {
      firstIndex = i
      firstOutcome =
        reason === 'band' ? 'sold-at-band' : reason === 'instant' ? 'sold-no-delay' : 'sold-at-expiry'
    }
    debt -= repaid
    collBase = r > 0 ? (collAt - seized) / r : 0
    timer.clearAfterSale()
    return debt > 1e-6 && collBase > 1e-6 && sales < maxSales
  }

  // t0. Delayed: armed by the breach the census located, TimerStarted (:1393-1419).
  // No-delay: sold now, instant mode (clause vii) — `live` is false if that sale ended it.
  const act0 = timer.step(0, ltv0)
  const live = act0.kind === 'sell' ? sell(0, 1, act0.reason) : true

  for (let i = 1; live && i < n; i++) {
    const raw = series[i]
    // Oracle gap: carry the last observation forward. The delay is wall time and
    // keeps running through a gap.
    const r = raw == null || !(raw > 0) ? lastRatio : raw
    lastRatio = r
    const collAt = collBase * r
    const ltv = collAt > 0 ? debt / collAt : debt > 0 ? Infinity : 0

    const act = timer.step(i, ltv)
    if (act.kind === 'sell') {
      if (!sell(i, r, act.reason)) break
    }
  }

  // The grid ran out. An unresolved delay is credited to nobody: sell at the last
  // price we have, which is the conservative reading.
  if (timer.armed) {
    const before = sales
    sell(n - 1, lastRatio, 'expiry')
    if (before === 0 && sales > 0) firstOutcome = 'sold-at-grid-end'
  }

  const firstCure = timer.firstCureIndex === null ? null : timer.firstCureIndex * minutesPerStep

  if (sales === 0) {
    return {
      closedUsd: 0,
      closedAtIndex: null,
      outcome: firstCure === null ? 'held' : 'cured-then-held',
      minutesToFirstCure: firstCure,
      breaches: timer.breaches,
      sales: 0,
    }
  }

  return {
    closedUsd: closed,
    closedAtIndex: firstIndex,
    outcome: firstOutcome ?? 'sold-at-expiry',
    minutesToFirstCure: firstCure,
    breaches: timer.breaches,
    sales,
  }
}
