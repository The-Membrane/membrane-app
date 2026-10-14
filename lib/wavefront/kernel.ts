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
 * each leg at every minute (null = no observation: that leg's last ratio is carried
 * forward, the clock keeps running). The composite is
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
 * ONE DELIBERATE DIFFERENCE FROM cureWalk, AND ONE INHERITED BEHAVIOUR
 * ---------------------------------------------------------------------------
 * - START-UNBREACHED. cureWalk returns 'sold-immediately-unlocated-line' (one repay, and the
 *   census excludes the row) when LTV0 <= line. The kernel just walks: a half of a split mixed
 *   position can open under its own line, and that is a healthy position, not a data defect.
 *   Locating a breach is the caller's job (the census decides `walked` from the protocol's own
 *   health check before it builds a kernel).
 * - SOLD AT t0 PAST THE BAND. cureWalk sells a delayed position that is already past
 *   line × (1 + band) at t0 ONCE and stops walking it. The kernel does the same by default so
 *   the two agree; `walkOnAfterT0BandSale: true` walks it on like every other sale (the census
 *   publishes that as a sensitivity).
 */

import {
  DelayTimer,
  cureSale,
  type CureOutcome,
  type CureSaleParams,
  type SaleReason,
} from '../position-sim/curePath'
import { membraneRepayValue } from '../position-sim/membrane'
import { memTs, type MemEvent, type MemRecord, type SaleWhy } from './stream'

export interface KernelLeg {
  /** Key the ratio function is asked about (an asset address, an oracle address, …). */
  key: string
  symbol: string
  /** Value at t0, in the position's unit (USD for Aave; loan-token units for Morpho). */
  value0: number
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
  /** Walk on after a delayed sale at t0 past the band (cureWalk stops). Default false. */
  walkOnAfterT0BandSale?: boolean
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
}

const outcomeFor = (reason: SaleReason): CureOutcome =>
  reason === 'band' ? 'sold-at-band' : reason === 'instant' ? 'sold-no-delay' : 'sold-at-expiry'

export class MembraneKernel {
  readonly spec: KernelSpec
  private readonly timer: DelayTimer
  private readonly params: CureSaleParams
  private readonly wC: number[]
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
   * One sale at composite ratio r (debt-basket ratio dv), cureWalk's `sell`. Returns the
   * record (or null when the sized repay was not positive) and whether the walk goes on.
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
    this.closed += s.repaid
    this.sales = s.sales
    if (this.firstIndex === null) {
      this.firstIndex = index
      this.firstOutcome = outcomeFor(reason)
    }
    this.debt = s.debt
    this.collBase = s.collBase
    this.timer.clearAfterSale()
    const rec = this.record(
      minute,
      reason === 'instant' ? 'sell-instant' : 'sell',
      ltv,
      s.repaid * dv,
      s.seized * dv,
      why,
    )
    this.repaidUsd =
      this.repaidUsd == null || rec.repaidUsd == null ? null : this.repaidUsd + rec.repaidUsd
    this.soldUsd = this.soldUsd == null || rec.soldUsd == null ? null : this.soldUsd + rec.soldUsd
    return { rec, live: s.live }
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
      this.done = true
      return out
    }

    const ltv0 = this.debt0 / this.coll0
    if (ltv0 <= s.line) this.startUnbreached = true

    // Past the band at t0, delayed class: `Immediate` (LiquidationEngine.sol:1390).
    if (!s.noDelay && ltv0 > s.line * (1 + s.band)) {
      const act = this.timer.step(0, ltv0) // counts the breach; returns sell/band
      if (act.kind !== 'sell') throw new Error('unreachable: past the band must sell')
      const live = push(this.sell(m, 0, 1, 1, 'band', ltv0, 'band'))
      this.firstOutcome = 'sold-at-t0'
      if (!s.walkOnAfterT0BandSale || !live) this.done = true
      if (!s.walkOnAfterT0BandSale) this.special = { outcome: 'sold-at-t0', breaches: 1 }
      return out
    }

    // No minute after t0 to walk: cureWalk's one repay, 'sold-immediately-no-series'.
    if (s.t0Minute >= s.lastMinute && ltv0 > s.line) {
      const act = this.timer.step(0, ltv0)
      if (act.kind === 'arm') out.push(this.record(m, 'arm', ltv0, 0, 0))
      this.oneRepay(m, ltv0, out)
      this.timer.clearAfterSale()
      this.special = { outcome: 'sold-immediately-no-series', breaches: 1 }
      this.done = true
      return out
    }

    // Delayed in the band: armed (TimerStarted). No-delay over the line: sold now.
    // At or under the line: nothing — the position simply walks.
    const act0 = this.timer.step(0, ltv0)
    if (act0.kind === 'arm') out.push(this.record(m, 'arm', ltv0, 0, 0))
    else if (act0.kind === 'sell') {
      const live = push(this.sell(m, 0, 1, 1, act0.reason, ltv0, act0.reason))
      if (!live) this.done = true
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
    this.closed = r
    this.sales = 1
    this.firstIndex = 0
    const seized = Math.min(r, this.coll0)
    const rec = this.record(
      minute,
      this.spec.noDelay ? 'sell-instant' : 'sell',
      ltv,
      r,
      seized,
      'no-series',
    )
    this.repaidUsd = rec.repaidUsd
    this.soldUsd = rec.soldUsd
    this.debt = Math.max(0, this.debt0 - r)
    out.push(rec)
  }

  /**
   * One grid minute after t0. `ratioOf(leg)` = that leg's price at this minute over its price
   * at t0 (null / non-positive = no observation: carried forward). Minutes must increase.
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

    let c = 0
    for (let k = 0; k < s.collateral.length; k++) {
      const raw = ratioOf(s.collateral[k])
      const r = raw == null || !(raw > 0) ? this.lastC[k] : raw
      this.lastC[k] = r
      c += this.wC[k] * r
    }
    let d = 0
    for (let k = 0; k < s.debt.length; k++) {
      const raw = ratioOf(s.debt[k])
      const q = raw == null || !(raw > 0) ? this.lastD[k] : raw
      this.lastD[k] = q
      d += this.wD[k] * q
    }
    const r = c / d
    this.lastR = r
    this.lastDv = d

    const collAt = this.collBase * r
    const ltv = collAt > 0 ? this.debt / collAt : this.debt > 0 ? Infinity : 0
    const act = this.timer.step(i, ltv)
    if (act.kind === 'arm') return [this.record(minute, 'arm', ltv, 0, 0)]
    if (act.kind === 'save') return [this.record(minute, 'save', ltv, 0, 0)]
    if (act.kind === 'sell') {
      const x = this.sell(minute, i, r, d, act.reason, ltv, act.reason)
      if (!x.live) this.done = true
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
    if (!this.timer.armed) return []
    this.armedAtGridEnd = true
    const s = this.spec
    const before = this.sales
    const last = s.lastMinute
    const collAt = this.collBase * this.lastR
    const ltv = collAt > 0 ? this.debt / collAt : this.debt > 0 ? Infinity : 0
    const x = this.sell(last, last - s.t0Minute, this.lastR, this.lastDv, 'expiry', ltv, 'grid-end')
    if (before === 0 && this.sales > 0) this.firstOutcome = 'sold-at-grid-end'
    this.done = true
    return x.rec ? [x.rec] : []
  }

  result(): KernelResult {
    const firstCure = this.timer.firstCureIndex
    const base = {
      repaidUsd: this.repaidUsd,
      soldUsd: this.soldUsd,
      armedAtGridEnd: this.armedAtGridEnd,
      startUnbreached: this.startUnbreached,
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
