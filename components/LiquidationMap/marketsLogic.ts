// Market-side analytics — pure logic (no I/O). Ports of the research prototype
// q26_terminal.py (feed_kind, borrow_rate, util_for_rate, rate_headroom,
// history_breaches, carry_metrics) plus the X-ray what-if. All MEASURED or
// arithmetic on measured inputs; nothing here forecasts.

import { xrayMetrics, type XrayReserve, type XrayResult } from './xrayLogic'

export type FeedKind = 'market feed' | 'exchange-rate (capped)' | 'capped peg' | 'unknown'

export function feedKind(desc: string | null | undefined): FeedKind {
  if (!desc) return 'unknown'
  const d = desc.toLowerCase()
  if (d.startsWith('capped') && d.includes('/')) {
    return (d.match(/\//g) ?? []).length >= 2 || d.includes('(')
      ? 'exchange-rate (capped)'
      : 'capped peg'
  }
  return 'market feed'
}

export type RateParams = { opt: number; base: number; s1: number; s2: number }

export function borrowRate(u: number, p: RateParams): number {
  return (
    p.base +
    (p.s1 * Math.min(u, p.opt)) / p.opt +
    (u > p.opt ? (p.s2 * (u - p.opt)) / (1 - p.opt) : 0)
  )
}

/** Smallest utilization whose borrow rate reaches target, or null if never. */
export function utilForRate(target: number, p: RateParams): number | null {
  if (target <= p.base) return 0
  if (target <= p.base + p.s1) return (p.opt * (target - p.base)) / p.s1
  if (p.s2 <= 0) return null
  const u = p.opt + ((target - p.base - p.s1) * (1 - p.opt)) / p.s2
  return u <= 1 ? u : null
}

export type Headroom = {
  utilNow: number | null
  utilAtTarget: number | null
  withdrawalsToTarget: number | null // asset units
  newBorrowsToTarget: number | null // asset units
}

/** Utilization is implied from the live rate (Aave uses virtual balances). */
export function rateHeadroom(
  debt: number,
  rateNow: number,
  p: RateParams,
  target: number,
): Headroom {
  const uNow = utilForRate(rateNow, p)
  const uT = utilForRate(target, p)
  if (!uNow || uT === null)
    return { utilNow: uNow, utilAtTarget: uT, withdrawalsToTarget: null, newBorrowsToTarget: null }
  const total = debt / uNow
  return {
    utilNow: uNow,
    utilAtTarget: uT,
    withdrawalsToTarget: uT > 0 ? Math.max(0, total - debt / uT) : null,
    newBorrowsToTarget: Math.max(0, uT * total - debt),
  }
}

export type Bar = { t: number; close: number; low: number } // t = open time, ms

export type Breaches = Record<
  string,
  { windows: number; breaches: number; worst: { drop: number; start: string }[] }
>

/** Past windows whose low fell at least d below the close before them. History, not a probability. */
export function historyBreaches(bars: Bar[], d: number, windows = [1, 7, 30], worst = 3): Breaches {
  const out: Breaches = {}
  for (const w of windows) {
    let n = 0
    let hits = 0
    const drops: [number, number][] = []
    for (let i = 0; i + w < bars.length; i++) {
      let lo = Infinity
      for (let j = i + 1; j <= i + w; j++) lo = Math.min(lo, bars[j].low)
      const dd = 1 - lo / bars[i].close
      n++
      if (dd >= d) hits++
      drops.push([dd, bars[i + 1].t])
    }
    drops.sort((a, b) => b[0] - a[0])
    const top: { drop: number; start: string }[] = []
    const seen: number[] = []
    for (const [dd, t] of drops) {
      if (seen.every((u) => Math.abs(t - u) > w * 86_400_000)) {
        top.push({ drop: dd, start: new Date(t).toISOString().slice(0, 10) })
        seen.push(t)
      }
      if (top.length === worst) break
    }
    out[`${w}d`] = { windows: n, breaches: hits, worst: top }
  }
  return out
}

/**
 * HF log-drift at today's rates for a loop: collateral growth (yield + supply APR) minus debt
 * growth (borrow APR + the debt asset's own ratio growth). Rates held constant: scenario arithmetic.
 */
export function carryGap(
  legs: {
    collateralUsd: number
    debtUsd: number
    yieldApr: number
    supplyApr: number
    borrowApr: number
  }[],
  hf: number | null,
): { carryGapPerYear: number | null; daysToHf1: number | null } {
  let cv = 0
  let dv = 0
  let cy = 0
  let dy = 0
  for (const l of legs) {
    cv += l.collateralUsd
    cy += l.collateralUsd * (l.yieldApr + l.supplyApr)
    dv += l.debtUsd
    dy += l.debtUsd * (l.borrowApr + l.yieldApr)
  }
  if (!cv || !dv) return { carryGapPerYear: null, daysToHf1: null }
  const gap = dy / dv - cy / cv
  const days = gap > 0 && hf !== null && hf > 1 ? (Math.log(hf) / gap) * 365 : null
  return { carryGapPerYear: gap, daysToHf1: days }
}

export type WhatIf = {
  priceMovePct: number
  repayUsd: number
  addCollateralUsd: number
  /** Ratio loops: move only non-stable collateral against the debt (the ratio), not both legs. */
  ratioOnly?: boolean
}

/**
 * What-if on a position: every non-stable price moves by priceMovePct (stables fixed), debt is
 * repaid pro rata, collateral is added to the main collateral. Returns the re-run X-ray.
 */
export function applyWhatIf(
  reserves: (XrayReserve & { stable: boolean })[],
  w: WhatIf,
  main: string,
): XrayResult {
  const k = 1 + w.priceMovePct / 100
  const debt = reserves.reduce((a, r) => a + r.debtUsd, 0)
  const repayShare = debt > 0 ? Math.min(1, Math.max(0, w.repayUsd) / debt) : 0
  const moved = reserves.map((r) => {
    const f = r.stable ? 1 : k
    return {
      ...r,
      priceUsd: r.priceUsd * f,
      collateralUsd:
        r.collateralUsd * f + (r.symbol === main ? Math.max(0, w.addCollateralUsd) : 0),
      debtUsd: r.debtUsd * (w.ratioOnly ? 1 : f) * (1 - repayShare),
    }
  })
  return xrayMetrics(moved)
}

/** Utilization from balances, and the borrows or withdrawals (same units) that reach the kink. */
export function kinkHeadroom(debt: number, available: number, opt: number) {
  const total = debt + available
  if (!(total > 0)) return { utilization: null, borrowsToKink: null, withdrawalsToKink: null }
  return {
    utilization: debt / total,
    borrowsToKink: Math.max(0, opt * total - debt),
    withdrawalsToKink: opt > 0 ? Math.max(0, total - debt / opt) : null,
  }
}

/** Base asset an exchange-rate feed is quoted against, from its description. */
export function feedBase(desc: string | null): string | null {
  if (!desc) return null
  const d = desc.toUpperCase()
  if (d.includes('ETH')) return 'WETH'
  if (d.includes('USDT')) return 'USDT'
  if (d.includes('USDC')) return 'USDC'
  if (d.includes('BTC')) return 'WBTC'
  return null
}

/** Annualized log growth of price(asset)/price(base) over windowDays. */
export function ratioYield(
  now: number,
  nowBase: number,
  old: number,
  oldBase: number,
  windowDays: number,
) {
  if (!(now > 0 && nowBase > 0 && old > 0 && oldBase > 0)) return null
  return (Math.log(now / nowBase / (old / oldBase)) * 365) / windowDays
}

/** Loop return on equity at leverage L (assets / equity): yield·L − borrow·(L − 1). */
export function loopReturn(yieldApr: number, borrowApr: number, leverage: number) {
  return yieldApr * leverage - borrowApr * (leverage - 1)
}

/** Compound v3 per-second rate (1e18) → APR. */
export function cometApr(perSecond: bigint): number {
  return (Number(perSecond) * 31_536_000) / 1e18
}

export type VenueQuote = {
  asset: string
  venue: string
  borrowApr: number
  availableUsd: number
  utilization: number | null
}

/** Quotes grouped by asset, cheapest first; `spread` = this venue minus the cheapest. */
export function rankQuotes(quotes: VenueQuote[]) {
  const by = new Map<string, VenueQuote[]>()
  for (const q of quotes) by.set(q.asset, [...(by.get(q.asset) ?? []), q])
  return [...by.entries()].map(([asset, qs]) => {
    const sorted = [...qs].sort((a, b) => a.borrowApr - b.borrowApr)
    const best = sorted[0].borrowApr
    return { asset, quotes: sorted.map((q) => ({ ...q, spread: q.borrowApr - best })) }
  })
}

export type HourBar = { t: number; open: number; high: number; low: number; close: number }

export type ReplayOutcome = {
  aave: { liquidated: boolean; hour: number | null }
  membrane: {
    outcome: 'survived' | 'immediate' | 'timer'
    hour: number | null
    timerStartHour: number | null
  }
}

/**
 * Replays one crash window on a fixed liquidation line under two rule sets (no user action):
 *  - Aave: liquidated at the first hour whose LOW touches the line (near-spot oracle).
 *  - Membrane (LiquidationEngine at 70f965e): a 1 h average price (proxy: the hour's OHLC
 *    mean); at or below line / (1 + band) → immediate; at or below the line → an 8 h timer
 *    starts; at or below the line again in hours 8–16 of the timer → liquidated; at 16 h a
 *    stale timer lapses. Timer clearing by a keeper is not assumed.
 * Hours are counted from the first bar.
 */
export function replayCrash(
  bars: HourBar[],
  line: number,
  band = 0.04,
  timerH = 8,
  lapseH = 16,
): ReplayOutcome {
  const aaveHour = bars.findIndex((b) => b.low <= line)
  let timer: number | null = null
  let firstTimer: number | null = null
  let mem: ReplayOutcome['membrane'] = { outcome: 'survived', hour: null, timerStartHour: null }
  for (let h = 0; h < bars.length; h++) {
    const b = bars[h]
    const twap = (b.open + b.high + b.low + b.close) / 4
    if (twap <= line / (1 + band)) {
      mem = { outcome: 'immediate', hour: h, timerStartHour: firstTimer }
      break
    }
    if (timer !== null && h - timer >= lapseH) timer = null
    if (twap <= line) {
      if (timer === null) {
        timer = h
        firstTimer ??= h
      } else if (h - timer >= timerH) {
        mem = { outcome: 'timer', hour: h, timerStartHour: timer }
        break
      }
    }
  }
  if (mem.outcome === 'survived') mem = { ...mem, timerStartHour: firstTimer }
  return {
    aave: { liquidated: aaveHour >= 0, hour: aaveHour >= 0 ? aaveHour : null },
    membrane: mem,
  }
}
