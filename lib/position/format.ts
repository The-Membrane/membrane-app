/**
 * Figures for the /position page. en-US grouping, a true minus sign, and no rounding that
 * the caller did not ask for: every function here prints the value it is given.
 */

const nf = (decimals: number) =>
  new Intl.NumberFormat('en-US', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })

/** "$1,813" / "$1.072". */
export const fmtUsd = (x: number, decimals = 0): string => `$${nf(decimals).format(x)}`

/** "0.53" / "1,240". */
export const fmtAmount = (x: number, decimals: number): string => nf(decimals).format(x)

/** "2,365" */
export const fmtInt = (x: number): string => nf(0).format(x)

/** A signed whole-percent move: "−34%" for a fall, "+34%" for a rise. */
export const fmtMove = (pct: number, direction: 'fall' | 'rise'): string =>
  `${direction === 'fall' ? '−' : '+'}${pct}%`

/**
 * The rounding step for a top-up amount: one step is worth $10 or more,
 * i.e. step = 10^ceil(log10($10 / price)). ETH near $4,000 → 0.01, a $1 stable → 10.
 * Families the page quotes in their usual precision override it (amountStepFor).
 */
export function amountStep(priceUsd: number): number {
  if (!(priceUsd > 0)) throw new Error('amountStep: price must be positive')
  const e = Math.ceil(Math.log10(10 / priceUsd) - 1e-12)
  // 1 / 10^k, not 10^−k: 10 ** -4 is 0.00009999999999999999 in IEEE doubles.
  return e >= 0 ? 10 ** e : 1 / 10 ** -e
}

/** Usual quoting precision: 0.01 for the ETH family, 0.0001 for the BTC family. */
export const FAMILY_STEP = { ETH: 0.01, BTC: 0.0001 } as const

/** The family step when there is one, else amountStep(price). */
export function amountStepFor(family: 'ETH' | 'BTC' | null, priceUsd: number): number {
  return family ? FAMILY_STEP[family] : amountStep(priceUsd)
}

export const stepDecimals = (step: number): number => Math.max(0, Math.round(-Math.log10(step)))

/** Rounds UP to a multiple of `step`, tolerant of float noise in the multiple. */
export function ceilTo(x: number, step: number): number {
  const k = Math.ceil(x / step - 1e-9)
  const d = stepDecimals(step)
  return Number((k * step).toFixed(d))
}

/** "14:05 UTC, 14 Oct 2026" */
export function fmtUtc(ms: number): string {
  const d = new Date(ms)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const month = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' })
  return `${hh}:${mm} UTC, ${d.getUTCDate()} ${month} ${d.getUTCFullYear()}`
}
