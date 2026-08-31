// Pure math + formatters ported from the inline JS in public/proto/carry.html.
// The DOM-imperative painters (paintColl / paintLadder / paintTimeline /
// renderRoutes) become the derived values below; React renders from them.
import { Board, Collateral, ExecConfig, Preset } from './types'
import { ABSORB, ROUTE_SCALE } from './fixtures'

/** '$12,345' — round then group. */
export function formatUSD(n: number): string {
  return '$' + Math.round(n).toLocaleString('en-US')
}

/** Strip everything but digits/decimal from a free-text amount field. */
export function parseAmount(raw: string): number {
  return parseFloat((raw || '0').replace(/[^0-9.]/g, '')) || 0
}

/** Derived per-rung ladder metrics for a collateral at leverage L. */
export interface RungMetrics {
  L: number
  /** Effective LTV, capped at the asset's max draw. */
  ltv: number
  /** Net carry on equity, % / yr (borrow ~0% ⇒ ~L × yield). */
  carry: number
  /** Price fall that reaches breach from this rung, %. */
  fall: number
  /** How many measured 1-in-1000 8h moves fit inside the fall. */
  cover: number
  /** Under 3× covered ⇒ flagged thin. */
  danger: boolean
  /** Share of room the 1-in-1000 move uses, 0–100. */
  roomUsed: number
}

export function rungMetrics(c: Collateral, L: number): RungMetrics {
  let ltv = (L - 1) / L
  if (ltv > c.maxLtv) ltv = c.maxLtv
  const carry = L * c.yld
  const fall = (1 - ltv / (c.maxLtv * 1.04)) * 100
  const cover = fall / c.p999
  const danger = cover < 3
  const roomUsed = Math.min(100, (c.p999 / Math.max(fall, 0.0001)) * 100)
  return { L, ltv, carry, fall, cover, danger, roomUsed }
}

/**
 * Provenance line under the ladder.
 *
 * Only assets carrying a `measured` block may claim measurement, and they quote
 * the range actually covered. Everything else says plainly that its tail is
 * unverified — the source dataset (collateral_rank.json) is not on disk and the
 * numbers cannot be recomputed. `ABSORB` came from that same missing dataset, so
 * it is only quoted alongside a measured tail.
 */
export function ladderStamp(c: Collateral): string {
  if (!c.measured) {
    return (
      `drawdown tail for ${c.sym} is UNVERIFIED — source dataset (collateral_rank.json) ` +
      `is missing and no ${c.sym} price history is available to recompute it · ` +
      `survival numbers below inherit that uncertainty · yields are today’s and move`
    )
  }
  return (
    `drawdown tail measured across ${c.n.toLocaleString()} rolling eight-hour windows, ` +
    `${c.measured.range} (${c.measured.source}) · window absorption ${ABSORB}% at max draw ` +
    `(unverified) · yields are today’s and move`
  )
}

/** Route bar geometry: which side, and how wide (0–50% of the track). */
export function routeBar(net: number): { positive: boolean; width: number } {
  return { positive: net >= 0, width: Math.min(50, (Math.abs(net) / ROUTE_SCALE) * 50) }
}

/** Confirm-sheet config for opening a carry from a ladder rung. */
export function rungExec(c: Collateral, L: number, equity: number): ExecConfig {
  const m = rungMetrics(c, L)
  return {
    title: `Carry — ${c.sym} at ${L}×`,
    rows: [
      { label: 'You post', value: `${formatUSD(equity * L)} ${c.sym}` },
      { label: 'You borrow', value: `${formatUSD(equity * (L - 1))} CDT` },
      { label: 'Your LTV', value: `${(m.ltv * 100).toFixed(0)}% · cap ${(c.maxLtv * 100).toFixed(0)}%` },
      { label: 'Net carry on equity, today', value: `+${m.carry.toFixed(1)}% / yr` },
      { label: '1-in-1000 8h move uses', value: `${Math.round(m.roomUsed)}% of your room` },
    ],
    note: 'Rates move; the carry is not fixed. A breach repays you to the cap, not to zero.',
    cta: 'Sign & open',
    done: 'Carry open',
  }
}

/** Confirm-sheet config for opening a carry from a preset (the one dial). */
export function presetExec(p: Preset, equity: number): ExecConfig {
  return {
    title: `Carry — ${p.nm}`,
    rows: [
      { label: 'Collateral (chosen for you)', value: p.coll },
      { label: 'You post', value: `${formatUSD(equity * p.lev)} ${p.coll}` },
      { label: 'You borrow', value: `${formatUSD(equity * (p.lev - 1))} CDT` },
      { label: 'Venue mix (chosen for you)', value: p.venues },
      { label: 'Net carry on equity, today', value: `+${(p.lev * p.yld).toFixed(1)}% / yr` },
      { label: '1-in-1000 8h move uses', value: `${p.room}% of your room` },
    ],
    note:
      'Every row above was picked by the preset. Customize each piece instead, or tune the venue mix on the Builder board — nothing here is hidden.',
    cta: 'Sign & open',
    done: 'Carry open',
  }
}

/** Turn a leaderboard row into a loaded preset (index 3 of the dial). */
export function boardToPreset(b: Board): Preset {
  return {
    id: 'loaded',
    nm: `Board: ${b.nm}`,
    lev: b.lev,
    coll: b.coll,
    yld: b.yld,
    venues: b.venues,
    room: b.room,
    pd: `${b.lev}× · ${b.surv} · loaded from boards`,
  }
}

/** Format the animated cure-timer label, e.g. "3h 12m of 8h". */
export function cureLabel(fraction: number): string {
  const mins = Math.round(fraction * 480)
  return `${Math.floor(mins / 60)}h ${String(mins % 60).padStart(2, '0')}m of 8h`
}
