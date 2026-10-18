/**
 * The INCREMENTAL Membrane state machine for one position — the piece the live wavefront
 * engine runs minute by minute, and the Oct 10-11 full-coverage census runs over the
 * recorded window.
 *
 * It is `cureWalk` (lib/position-sim/curePath.ts) turned inside out: instead of being handed
 * a whole ratio series, it is constructed once from the position at t0 and then fed one
 * minute at a time. It runs the SAME pieces:
 *
 *   - `DelayTimer` from curePath.ts decides arm / hold / save / sell (contract clauses
 *     (ii)-(vii) are documented there);
 *   - `cureSale` from curePath.ts sizes every sale — repay-to-cap with `membraneRepayValue`,
 *     the `liqDebtMinimum` floor and remainder guard, seized == repaid (no fee), and the
 *     remainder carried forward so the position walks on after a sale;
 *   - the t0 classification and the grid-end conservative sale are cureWalk's, branch for
 *     branch (see `start` and `finish`).
 *
 * tests/unit/wavefrontKernel.test.ts proves it: for every evidence.json cohort row with a
 * usable ratio series, the kernel fed that series closes the same dollars (<= 1e-6), first
 * sells at the same index and reports the same outcome as cureWalk.
 *
 * ---------------------------------------------------------------------------
 * MULTI-LEG PRICE INPUT
 * ---------------------------------------------------------------------------
 * cureWalk reads ONE composite ratio. The kernel is given legs — collateral and debt, each
 * with its value at t0 in the position's unit — and asks `ratioOf(leg)` = p(m) / p(t0) for
 * each leg at every minute. The composite is
 *
 *     C(m) = Σ w_i r_i(m)     w_i = collateral value share at t0
 *     D(m) = Σ u_j q_j(m)     u_j = debt value share at t0
 *     R(m) = C(m) / D(m)
 *
 * which is exactly cureWalk's `ratios[i]` (collateral over debt, debt held constant). Every
 * sale takes collateral and repays debt PRO RATA across legs, so the basket weights never
 * change and the scalar walk stays exact. With one collateral leg and one debt leg whose ratio
 * is 1, R(m) is the ratio itself bit for bit, which is what the equivalence test feeds.
 *
 * Amounts are carried on the t0 basis like cureWalk (`closedT0` == cureWalk.closedUsd). The
 * stream records report each sale at the minute it happens: repaid(t0 basis) × D(m) in the
 * position's unit, times `usdPerUnit(m)` (1 for a USD-valued position, the loan token's price
 * for a Morpho market). The line is held at its t0 value, as cureWalk holds it.
 *
 * ---------------------------------------------------------------------------
 * ONE DELIBERATE DIFFERENCE FROM cureWalk
 * ---------------------------------------------------------------------------
 * - START-UNBREACHED. cureWalk returns 'sold-immediately-unlocated-line' (one repay, and the
 *   census excludes the row) when LTV0 <= line. The kernel just walks: a half of a split mixed
 *   position can open under its own line, and that is a healthy position, not a data defect.
 *   Locating a breach is the caller's job (the census decides `walked` from the protocol's own
 *   health check before it builds a kernel).
 *
 * MISSING PRICES ARE AN ERROR BY DEFAULT. A null, zero or negative ratio for a held leg throws:
 * a frozen price looks exactly like a calm market, so silently carrying the last one forward
 * would let a dead feed hold a position "healthy". The Oct 10-11 census has no gap anywhere,
 * so it never needs more. `missingPrice: 'carry-forward'` exists for exactly one caller —
 * the cureWalk equivalence test, because cureWalk carries a null ratio forward — and the live
 * engine must decide its own gap policy explicitly rather than inherit a silent freeze.
 *
 * SOLD AT t0 PAST THE BAND: a delayed position already past line × (1 + band) at t0 is sold
 * at once (`Immediate`, LiquidationEngine.sol:1694-1703 at 16e12329) and then WALKS ON like
 * after every other sale: a sale leaves no timer (a band break or an expiry deletes it,
 * :1724-1727; an Immediate sale never had one) and nothing closes the position, so a later
 * breach can arm a fresh window and a later band break sells again. cureWalk does the same.
 * `stopAfterT0BandSale: true` reproduces the old stop after one repay, which both censuses
 * publish as a sensitivity.
 *
 * ---------------------------------------------------------------------------
 * PENDING ORDERS: LIQUIDITY-CAPPED SALES (owner ruling 2026-10-18)
 * ---------------------------------------------------------------------------
 * With `liquidity` set (lib/wavefront/liquidity.ts), a sale is an ORDER the market may fill only
 * in part. Without it, every order fills at once and the kernel is exactly the uncapped one
 * (same arithmetic, same records, bit for bit).
 *
 *   SIZING. The timer decides a sale exactly as before (band, expiry, no-delay, grid end, t0) and
 *     `cureSale` sizes it as before: repay to the borrow cap with the floor, seized == repaid
 *     (all collateral when underwater).
 *   SPLIT ACROSS LEGS. The collateral to sell is split PRO RATA BY VALUE across the legs — the
 *     same split cureSale's scalar walk makes — i.e. the same fraction q = seized / collateral of
 *     every leg's tokens. Each leg's tokens are offered to that leg's own (chain, token) window;
 *     each leg fills on its own (filled_k <= offered_k). The order's fill is the value filled:
 *     repaid = sized repay x (value filled / value offered). When every leg fills completely the
 *     kernel takes cureSale's own result (the uncapped arithmetic). When legs fill unevenly, the
 *     basket weights move to what is actually held, and the walk prices each leg by its own path.
 *   REMAINDER. The unfilled part of the repay stays PENDING (`pending`, in the position's unit).
 *     A sale that fills nothing still happened (the timer is gone): it is recorded with repaid 0.
 *   WHILE PENDING, at every later minute, before anything else:
 *     - the TIMER IS IDLE. The sale already deleted it (LiquidationEngine.sol:1724-1727); the
 *       position is being liquidated, so there is nothing to arm, save or break. No band test.
 *     - the order is RE-SIZED at this minute's price: target = the repay to cap (same cureSale
 *       sizing, floor included) on what is now held; the offer is min(pending, target). So the
 *       remainder sells at the later minute's oracle price, and never past the cap: if the price
 *       recovered and the position is back at or under its borrow cap, target is 0 and the
 *       remainder is CANCELLED (counted, never sold). The pending amount never grows: a further
 *       fall is not added to the order; once the order is done the timer classifies the position
 *       afresh, exactly as after any sale (a breach in the band arms a full new window; past the
 *       band it is sold at once).
 *     - the LTV moves with price on the collateral still held (the unsold part).
 *     - a carried fill is a `sell` record with `carry: true`; it is NOT a new sale (`sales` counts
 *       the timer's decisions; maxSales caps those, and a pending order still finishes after the
 *       cap is reached).
 *   GRID END. A remainder still pending at the last minute is not sold (there is no liquidity to
 *     sell it into): it is reported as `unfilledAtGridEnd`. The conservative grid-end sale of a
 *     running timer is an order like any other and is offered at the last minute.
 */

import {
  DelayTimer,
  cureSale,
  type CureOutcome,
  type CureSaleParams,
  type SaleReason,
} from '../position-sim/curePath'
import { membraneRepayValue } from '../position-sim/membrane'
import type { KernelLiquidity } from './liquidity'
import { memTs, type MemEvent, type MemRecord, type SaleWhy } from './stream'

export interface KernelLeg {
  /** Key the ratio function is asked about (an asset address, an oracle address, …). */
  key: string
  symbol: string
  /** Value at t0, in the position's unit (USD for Aave; loan-token units for Morpho). */
  value0: number
  /** Collateral legs, liquidity-capped runs only: tokens held at t0 (normalised). */
  tokens0?: number
  /** Collateral legs, liquidity-capped runs only: the book key (liquidity.ts liqKeyOf). */
  liqKey?: string
}

export interface KernelSpec {
  pid: string
  /** Index of this half when a mixed position is split (0 = no-delay legs, 1 = delayed). */
  sub?: number
  collateral: readonly KernelLeg[]
  debt: readonly KernelLeg[]
  /** The liquidation line (max LTV) the position is judged against, held at its t0 value. */
  line: number
  /** The no-delay class (curePath.ts clause vii): sold the minute it is over its line. */
  noDelay: boolean
  /** `max_threshold_to_delay` — MAX_THRESHOLD_TO_DELAY. Ignored when noDelay. */
  band: number
  /** The delay in grid steps (8 h = 480 one-minute steps). */
  delaySteps: number
  /** BORROW_LTV_GAP: the repay restores line - gap. */
  gap: number
  /** `liqDebtMinimum` in the position's unit. 0 disables the floor. */
  debtMinimum: number
  /** Hard cap on sales per position (cureWalk's 20). */
  maxSales: number
  /** Grid minute of t0 (the located liquidation). Minute 0 = the window start. */
  t0Minute: number
  /** Exact timestamp of t0 (the liquidating block). */
  t0Ts: number
  /** Window start (minute 0) and grid step, for record timestamps. */
  startTs: number
  stepSeconds: number
  /** Last minute of the grid. A delay still running after it is sold there (conservative). */
  lastMinute: number
  /** USD per position unit at a minute; null = unpriced (records carry null USD). Default 1. */
  usdPerUnit?: (minute: number) => number | null
  /** See DelayTimerOptions.noEarlyClear. Default false. */
  noEarlyClear?: boolean
  /** See CureWalkInput.maxRepayPerSaleUsd (in the position's unit). Default uncapped. */
  maxRepayPerSale?: number
  /**
   * SENSITIVITY ONLY: stop after the t0 sale of a delayed position past the band (the old
   * cureWalk behaviour, CureWalkInput.stopAfterT0BandSale). Default false: it walks on.
   */
  stopAfterT0BandSale?: boolean
  /**
   * What a null / zero / negative ratio does. 'throw' (the default): it is an error — see
   * MISSING PRICES in the header. 'carry-forward': the leg's last ratio stands (cureWalk's
   * semantics; the equivalence test only).
   */
  missingPrice?: 'throw' | 'carry-forward'
  /**
   * The market every sale is offered to (see PENDING ORDERS). Unset: every sale fills at once,
   * the uncapped walk. Every collateral leg then needs `tokens0` and `liqKey`.
   */
  liquidity?: KernelLiquidity
}

/** cureWalk's result fields, so the two engines can be compared field for field. */
export interface KernelResult {
  /** Debt closed across the whole path, on the t0 basis (== cureWalk.closedUsd). */
  closedT0: number
  /** Steps after t0 of the FIRST sale, or null. */
  closedAtIndex: number | null
  outcome: CureOutcome
  minutesToFirstCure: number | null
  breaches: number
  sales: number
  /** Σ repaid at each sale's own minute, USD (null when the unit is unpriced). */
  repaidUsd: number | null
  /** Σ collateral sold at each sale's own minute, USD. == repaidUsd unless underwater. */
  soldUsd: number | null
  /** A delay timer was still running when the grid ended (it was sold there). */
  armedAtGridEnd: boolean
  /** The position opened at or under its line (it walked without a t0 breach). */
  startUnbreached: boolean
  /** Sales (timer decisions) whose order did not fill completely at their own minute. */
  shortSales: number
  /** Later fills of a pending remainder (`carry` records). */
  carryFills: number
  /** Remainders cancelled because the position was back at or under its borrow cap. */
  pendingCancelled: number
  /** Repay still pending when the grid ended (position unit; 0 uncapped). Never sold. */
  unfilledAtGridEnd: number
  /** The same in USD at the last minute (null when the unit is unpriced). */
  unfilledAtGridEndUsd: number | null
}

const outcomeFor = (reason: SaleReason): CureOutcome =>
  reason === 'band' ? 'sold-at-band' : reason === 'instant' ? 'sold-no-delay' : 'sold-at-expiry'

export class MembraneKernel {
  readonly spec: KernelSpec
  private readonly timer: DelayTimer
  private readonly params: CureSaleParams
  /** Collateral weights on the t0 basis. Fixed unless a capped sale fills the legs unevenly. */
  private wC: number[]
  private readonly wD: number[]
  private readonly lastC: number[]
  private readonly lastD: number[]
  private readonly debt0: number
  private readonly coll0: number

  private debt: number
  private collBase: number
  private sales = 0
  private closed = 0
  private repaidUsd: number | null = 0
  private soldUsd: number | null = 0
  private firstIndex: number | null = null
  private firstOutcome: CureOutcome | null = null
  /** Terminal outcome set by a cureWalk early return. */
  private special: { outcome: CureOutcome; breaches: number } | null = null
  private lastR = 1
  private lastDv = 1
  private lastStepMinute: number
  private started = false
  private finished = false
  /** No further minute can change anything. */
  private done = false
  private armedAtGridEnd = false
  private startUnbreached = false
  /** Repay still to fill (position unit, the debt basket's t0 basis). */
  private pending = 0
  private pendingEvent: MemEvent = 'sell'
  private pendingWhy: SaleWhy = 'band'
  /** No further timer decision can happen (a pending order may still fill). */
  private decisionsOver = false
  private shortSales = 0
  private carryFills = 0
  private pendingCancelled = 0
  private unfilledAtGridEnd = 0
  private unfilledAtGridEndUsd: number | null = 0

  constructor(spec: KernelSpec) {
    this.spec = spec
    const sum = (xs: readonly KernelLeg[]) => xs.reduce((a, l) => a + l.value0, 0)
    this.coll0 = sum(spec.collateral)
    this.debt0 = sum(spec.debt)
    // Weights: a single leg is weight exactly 1, so R(m) is its ratio bit for bit.
    this.wC = spec.collateral.map((l) => (spec.collateral.length === 1 ? 1 : l.value0 / this.coll0))
    this.wD = spec.debt.map((l) => (spec.debt.length === 1 ? 1 : l.value0 / this.debt0))
    this.lastC = spec.collateral.map(() => 1)
    this.lastD = spec.debt.map(() => 1)
    this.debt = this.debt0
    this.collBase = this.coll0
    this.lastStepMinute = spec.t0Minute
    if (spec.liquidity) {
      for (const l of spec.collateral) {
        if (!(l.tokens0 != null && l.tokens0 >= 0) || !l.liqKey) {
          throw new Error(
            `kernel ${spec.pid}: a capped run needs tokens0 and liqKey on ${l.symbol}`,
          )
        }
      }
    }
    this.timer = new DelayTimer({
      line: spec.line,
      band: spec.band,
      delaySteps: spec.delaySteps,
      noEarlyClear: spec.noEarlyClear,
      noDelay: spec.noDelay,
    })
    this.params = {
      cap: Math.max(0, spec.line - spec.gap),
      debtMinimumUsd: spec.debtMinimum,
      repayCap:
        spec.maxRepayPerSale != null && spec.maxRepayPerSale >= 0 ? spec.maxRepayPerSale : Infinity,
      maxSales: spec.maxSales,
    }
  }

  get isDone(): boolean {
    return this.done
  }

  /** Repay still pending (position unit). */
  get pendingRepay(): number {
    return this.pending
  }

  /** Close the walk: no further decision; done once nothing is pending. */
  private endDecisions(): void {
    this.decisionsOver = true
    if (!(this.pending > 0)) this.done = true
  }

  get armed(): boolean {
    return this.timer.armed
  }

  /** Timestamp of a record at `minute`: t0's own second at t0, the minute start after it. */
  private tsAt(minute: number): number {
    const s = this.spec
    return memTs(minute, s.t0Minute, s.t0Ts, s.startTs, s.stepSeconds)
  }

  private usd(minute: number, units: number): number | null {
    const f = this.spec.usdPerUnit ? this.spec.usdPerUnit(minute) : 1
    return f == null || !Number.isFinite(f) ? null : units * f
  }

  private record(
    minute: number,
    event: MemEvent,
    ltv: number,
    repaid: number,
    sold: number,
    why?: SaleWhy,
  ): MemRecord {
    const r: MemRecord = {
      kind: 'mem',
      seq: 0,
      pid: this.spec.pid,
      ts: this.tsAt(minute),
      minute,
      event,
      repaidUsd: this.usd(minute, repaid),
      soldUsd: this.usd(minute, sold),
      ltv,
    }
    if (this.spec.sub !== undefined) r.sub = this.spec.sub
    if (why) r.why = why
    return r
  }

  /**
   * Offer a sized order to the market (see PENDING ORDERS). `s` is cureSale's result for the
   * whole order at composite ratio r. Returns the filled repay and seized value (position unit),
   * and whether cureSale's own state update applies (every leg filled completely).
   */
  private fill(
    minute: number,
    r: number,
    s: { repaid: number; seized: number },
  ): { repaid: number; seized: number; full: boolean; phi: number[] | null } {
    const liq = this.spec.liquidity
    if (!liq || !(s.seized > 0))
      return { repaid: s.repaid, seized: s.seized, full: true, phi: null }
    const legs = this.spec.collateral
    const collAt = this.collBase * r
    const q = collAt > 0 ? Math.min(1, s.seized / collAt) : 1
    const held = legs.map((l, k) =>
      l.value0 > 0 ? ((l.tokens0 as number) * this.collBase * this.wC[k]) / l.value0 : 0,
    )
    const offer = held.map((h) => h * q)
    const got = liq.take(
      minute,
      legs.map((l, k) => ({ liqKey: l.liqKey as string, tokens: offer[k] })),
    )
    if (got.every((g, k) => g === offer[k])) {
      return { repaid: s.repaid, seized: s.seized, full: true, phi: null }
    }
    // Leg values at this minute (position unit) and the share of each leg's holding sold.
    const d = this.lastDv
    const phi = held.map((h, k) => (h > 0 ? got[k] / h : 0))
    let offered = 0
    let filled = 0
    for (let k = 0; k < legs.length; k++) {
      const v = (this.collBase * this.wC[k] * this.lastC[k]) / d
      offered += v * q
      filled += v * phi[k]
    }
    const frac = offered > 0 ? Math.min(1, filled / offered) : 0
    return { repaid: s.repaid * frac, seized: s.seized * frac, full: false, phi }
  }

  /** Apply an uneven (capped) fill to the collateral basket: each leg keeps (1 - phi_k). */
  private applyPartial(phi: number[]): void {
    const base = this.wC.map((w, k) => this.collBase * w * (1 - phi[k]))
    const total = base.reduce((a, b) => a + b, 0)
    this.collBase = total > 0 ? total : 0
    if (total > 0) this.wC = base.map((b) => b / total)
  }

  /**
   * One sale at composite ratio r (debt-basket ratio dv), cureWalk's `sell`, offered to the
   * market when the run is capped. Returns the record (or null when the sized repay was not
   * positive) and whether the walk goes on.
   */
  private sell(
    minute: number,
    index: number,
    r: number,
    dv: number,
    reason: SaleReason,
    ltv: number,
    why: SaleWhy,
  ): { rec: MemRecord | null; live: boolean } {
    const s = cureSale(
      { debt: this.debt, collBase: this.collBase, sales: this.sales },
      r,
      this.params,
    )
    if (!s.sold) return { rec: null, live: s.live }
    this.lastDv = dv
    const f = this.fill(minute, r, s)
    this.sales = s.sales
    if (this.firstIndex === null) {
      this.firstIndex = index
      this.firstOutcome = outcomeFor(reason)
    }
    let live = s.live
    if (f.full) {
      this.closed += s.repaid
      this.debt = s.debt
      this.collBase = s.collBase
    } else {
      this.shortSales++
      this.closed += f.repaid
      this.debt -= f.repaid
      this.applyPartial(f.phi as number[])
      this.pending = s.repaid - f.repaid
      if (!(this.pending > 1e-9 * Math.max(1, this.debt0))) this.pending = 0
      this.pendingEvent = reason === 'instant' ? 'sell-instant' : 'sell'
      this.pendingWhy = why
      live = this.debt > 1e-6 && this.collBase > 1e-6
      if (!live) this.pending = 0
      else if (this.sales >= this.params.maxSales) live = false
    }
    this.timer.clearAfterSale()
    const rec = this.record(
      minute,
      reason === 'instant' ? 'sell-instant' : 'sell',
      ltv,
      f.repaid * dv,
      f.seized * dv,
      why,
    )
    if (this.pending > 0) rec.unfilledUsd = this.usd(minute, this.pending * dv)
    this.addUsd(rec)
    return { rec, live }
  }

  private addUsd(rec: MemRecord): void {
    this.repaidUsd =
      this.repaidUsd == null || rec.repaidUsd == null ? null : this.repaidUsd + rec.repaidUsd
    this.soldUsd = this.soldUsd == null || rec.soldUsd == null ? null : this.soldUsd + rec.soldUsd
  }

  /**
   * A minute with an order pending (see PENDING ORDERS): re-size it at this minute's price,
   * capped at what is pending, and offer it. The timer is idle. Returns the carry record.
   */
  private carry(minute: number, r: number, dv: number, ltv: number): MemRecord[] {
    const cap = Math.min(this.params.repayCap, this.pending)
    const s = cureSale({ debt: this.debt, collBase: this.collBase, sales: this.sales }, r, {
      ...this.params,
      repayCap: cap,
      maxSales: Infinity,
    })
    if (!s.sold) {
      // Back at or under the borrow cap (or nothing left): the remainder is not needed.
      this.pending = 0
      this.pendingCancelled++
      if (this.decisionsOver) this.done = true
      return []
    }
    const f = this.fill(minute, r, s)
    if (f.full) {
      this.debt = s.debt
      this.collBase = s.collBase
    } else {
      this.debt -= f.repaid
      this.applyPartial(f.phi as number[])
    }
    this.closed += f.repaid
    this.pending = s.repaid - f.repaid
    if (!(this.pending > 1e-9 * Math.max(1, this.debt0))) this.pending = 0
    if (!(this.debt > 1e-6 && this.collBase > 1e-6)) {
      this.pending = 0
      this.decisionsOver = true
    }
    if (this.pending === 0 && this.decisionsOver) this.done = true
    if (!(f.repaid > 0)) return []
    this.carryFills++
    // Backward compatible: a carried fill is the decision's own event and `why`, flagged carry.
    const rec = this.record(
      minute,
      this.pendingEvent,
      ltv,
      f.repaid * dv,
      f.seized * dv,
      this.pendingWhy,
    )
    rec.carry = true
    if (this.pending > 0) rec.unfilledUsd = this.usd(minute, this.pending * dv)
    this.addUsd(rec)
    return [rec]
  }

  /** t0: cureWalk's classification, branch for branch. Call once, before any `step`. */
  start(): MemRecord[] {
    if (this.started) throw new Error(`kernel ${this.spec.pid}: start() called twice`)
    this.started = true
    const s = this.spec
    const out: MemRecord[] = []
    const m = s.t0Minute
    const push = (x: { rec: MemRecord | null; live: boolean }) => {
      if (x.rec) out.push(x.rec)
      return x.live
    }

    // Nothing to value: cureWalk's one repay, 'sold-immediately-no-series', breaches 0.
    if (!(this.debt0 > 0) || !(this.coll0 > 0)) {
      const ltv = this.coll0 > 0 ? this.debt0 / this.coll0 : this.debt0 > 0 ? Infinity : 0
      this.oneRepay(m, ltv, out)
      this.special = { outcome: 'sold-immediately-no-series', breaches: 0 }
      this.decisionsOver = true
      this.done = true
      return out
    }

    const ltv0 = this.debt0 / this.coll0
    if (ltv0 <= s.line) this.startUnbreached = true

    // Past the band at t0, delayed class: `Immediate` (LiquidationEngine.sol:1698 at 16e12329).
    if (!s.noDelay && ltv0 > s.line * (1 + s.band)) {
      const act = this.timer.step(0, ltv0) // counts the breach; returns sell/band
      if (act.kind !== 'sell') throw new Error('unreachable: past the band must sell')
      const live = push(this.sell(m, 0, 1, 1, 'band', ltv0, 'band'))
      this.firstOutcome = 'sold-at-t0'
      if (s.stopAfterT0BandSale || !live) this.endDecisions()
      if (s.stopAfterT0BandSale) this.special = { outcome: 'sold-at-t0', breaches: 1 }
      return out
    }

    // No minute after t0 to walk: cureWalk's one repay, 'sold-immediately-no-series'.
    if (s.t0Minute >= s.lastMinute && ltv0 > s.line) {
      const act = this.timer.step(0, ltv0)
      if (act.kind === 'arm') out.push(this.record(m, 'arm', ltv0, 0, 0))
      this.oneRepay(m, ltv0, out)
      this.timer.clearAfterSale()
      this.special = { outcome: 'sold-immediately-no-series', breaches: 1 }
      this.decisionsOver = true
      this.done = true
      return out
    }

    // Delayed in the band: armed (TimerStarted). No-delay over the line: sold now.
    // At or under the line: nothing — the position simply walks.
    const act0 = this.timer.step(0, ltv0)
    if (act0.kind === 'arm') out.push(this.record(m, 'arm', ltv0, 0, 0))
    else if (act0.kind === 'sell') {
      const live = push(this.sell(m, 0, 1, 1, act0.reason, ltv0, act0.reason))
      if (!live) this.endDecisions()
    }
    return out
  }

  /** cureWalk's early-return repay: sized once at t0 prices, not walked on. */
  private oneRepay(minute: number, ltv: number, out: MemRecord[]): void {
    const p = this.params
    const r = Math.min(
      membraneRepayValue(this.debt0, this.coll0, p.cap, p.debtMinimumUsd),
      p.repayCap,
    )
    const seized0 = Math.min(r, this.coll0)
    // Offered to the market like any order; there is no later minute, so what does not fill
    // is unfilled at the grid end.
    const f = this.fill(minute, 1, { repaid: r, seized: seized0 })
    this.closed = f.repaid
    this.sales = 1
    this.firstIndex = 0
    if (!f.full) {
      this.shortSales++
      this.unfilledAtGridEnd = r - f.repaid
      this.unfilledAtGridEndUsd = this.usd(minute, this.unfilledAtGridEnd)
    }
    const rec = this.record(
      minute,
      this.spec.noDelay ? 'sell-instant' : 'sell',
      ltv,
      f.repaid,
      f.seized,
      'no-series',
    )
    if (!f.full) rec.unfilledUsd = this.unfilledAtGridEndUsd
    this.repaidUsd = rec.repaidUsd
    this.soldUsd = rec.soldUsd
    this.debt = Math.max(0, this.debt0 - f.repaid)
    out.push(rec)
  }

  /**
   * One grid minute after t0. `ratioOf(leg)` = that leg's price at this minute over its price
   * at t0. A null / non-positive ratio throws unless `missingPrice: 'carry-forward'`. Minutes
   * must increase.
   */
  step(minute: number, ratioOf: (leg: KernelLeg) => number | null | undefined): MemRecord[] {
    if (!this.started) throw new Error(`kernel ${this.spec.pid}: step() before start()`)
    if (this.done || this.finished) return []
    if (!(minute > this.lastStepMinute)) {
      throw new Error(`kernel ${this.spec.pid}: minute ${minute} after ${this.lastStepMinute}`)
    }
    if (minute > this.spec.lastMinute) return []
    this.lastStepMinute = minute
    const s = this.spec
    const i = minute - s.t0Minute

    const carry = s.missingPrice === 'carry-forward'
    const missing = (leg: KernelLeg, raw: number | null | undefined) => {
      if (!carry) {
        throw new Error(
          `kernel ${s.pid}: no price for ${leg.symbol} (${leg.key}) at minute ${minute} (ratio ${raw}); ` +
            'a missing price is an error, never carried forward silently',
        )
      }
    }
    let c = 0
    for (let k = 0; k < s.collateral.length; k++) {
      const raw = ratioOf(s.collateral[k])
      if (raw == null || !(raw > 0)) missing(s.collateral[k], raw)
      const r = raw == null || !(raw > 0) ? this.lastC[k] : raw
      this.lastC[k] = r
      c += this.wC[k] * r
    }
    let d = 0
    for (let k = 0; k < s.debt.length; k++) {
      const raw = ratioOf(s.debt[k])
      if (raw == null || !(raw > 0)) missing(s.debt[k], raw)
      const q = raw == null || !(raw > 0) ? this.lastD[k] : raw
      this.lastD[k] = q
      d += this.wD[k] * q
    }
    const r = c / d
    this.lastR = r
    this.lastDv = d

    const collAt = this.collBase * r
    const ltv = collAt > 0 ? this.debt / collAt : this.debt > 0 ? Infinity : 0
    // An order still pending is worked first; the timer is idle (PENDING ORDERS).
    if (this.pending > 0) return this.carry(minute, r, d, ltv)
    if (this.decisionsOver) {
      this.done = true
      return []
    }
    const act = this.timer.step(i, ltv)
    if (act.kind === 'arm') return [this.record(minute, 'arm', ltv, 0, 0)]
    if (act.kind === 'save') return [this.record(minute, 'save', ltv, 0, 0)]
    if (act.kind === 'sell') {
      const x = this.sell(minute, i, r, d, act.reason, ltv, act.reason)
      if (!x.live) this.endDecisions()
      return x.rec ? [x.rec] : []
    }
    return []
  }

  /**
   * The grid ran out. A delay still running is credited to nobody: sold at the last price
   * (cureWalk's conservative grid-end sale). Call once, after the last `step`.
   */
  finish(): MemRecord[] {
    if (this.finished) return []
    this.finished = true
    const out: MemRecord[] = []
    if (this.timer.armed && !this.decisionsOver) out.push(...this.gridEndSale())
    if (this.pending > 0) {
      // Nothing left to sell it into: unfilled, reported, never credited.
      this.unfilledAtGridEnd += this.pending
      const u = this.usd(this.spec.lastMinute, this.pending * this.lastDv)
      this.unfilledAtGridEndUsd =
        this.unfilledAtGridEndUsd == null || u == null ? null : this.unfilledAtGridEndUsd + u
      this.pending = 0
    }
    this.done = true
    return out
  }

  private gridEndSale(): MemRecord[] {
    this.armedAtGridEnd = true
    const s = this.spec
    const before = this.sales
    const last = s.lastMinute
    const collAt = this.collBase * this.lastR
    const ltv = collAt > 0 ? this.debt / collAt : this.debt > 0 ? Infinity : 0
    const x = this.sell(last, last - s.t0Minute, this.lastR, this.lastDv, 'expiry', ltv, 'grid-end')
    if (before === 0 && this.sales > 0) this.firstOutcome = 'sold-at-grid-end'
    return x.rec ? [x.rec] : []
  }

  result(): KernelResult {
    const firstCure = this.timer.firstCureIndex
    const base = {
      repaidUsd: this.repaidUsd,
      soldUsd: this.soldUsd,
      armedAtGridEnd: this.armedAtGridEnd,
      startUnbreached: this.startUnbreached,
      shortSales: this.shortSales,
      carryFills: this.carryFills,
      pendingCancelled: this.pendingCancelled,
      unfilledAtGridEnd: this.unfilledAtGridEnd,
      unfilledAtGridEndUsd: this.unfilledAtGridEndUsd,
    }
    if (this.special) {
      return {
        ...base,
        closedT0: this.closed,
        closedAtIndex: 0,
        outcome: this.special.outcome,
        minutesToFirstCure: null,
        breaches: this.special.breaches,
        sales: this.sales,
      }
    }
    const minutesPerStep = this.spec.stepSeconds / 60
    const cure = firstCure === null ? null : firstCure * minutesPerStep
    if (this.sales === 0) {
      return {
        ...base,
        closedT0: 0,
        closedAtIndex: null,
        outcome: cure === null ? 'held' : 'cured-then-held',
        minutesToFirstCure: cure,
        breaches: this.timer.breaches,
        sales: 0,
      }
    }
    return {
      ...base,
      closedT0: this.closed,
      closedAtIndex: this.firstIndex,
      outcome: this.firstOutcome ?? 'sold-at-expiry',
      minutesToFirstCure: cure,
      breaches: this.timer.breaches,
      sales: this.sales,
    }
  }
}
