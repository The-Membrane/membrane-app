/** Number wording shared by rule titles and the Telegram formatter. Plain ASCII-safe text. */

export function fmtUsd(v: number): string {
  if (!Number.isFinite(v)) return 'n/a'
  const a = Math.abs(v)
  const sign = v < 0 ? '-' : ''
  if (a >= 1e9) return `${sign}$${(a / 1e9).toFixed(2)}B`
  if (a >= 1e6) return `${sign}$${(a / 1e6).toFixed(2)}M`
  if (a >= 1e4) return `${sign}$${(a / 1e3).toFixed(1)}K`
  if (a >= 100) return `${sign}$${a.toFixed(0)}`
  if (a >= 1) return `${sign}$${a.toFixed(2)}`
  return `${sign}$${a.toFixed(4)}`
}

/** Price with sensible precision: $2,612 / $0.9657. */
export function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return 'n/a'
  if (Math.abs(v) >= 1000) return `$${Math.round(v).toLocaleString('en-US')}`
  if (Math.abs(v) >= 10) return `$${v.toFixed(2)}`
  return `$${v.toFixed(4)}`
}

/** Fraction → percent, e.g. 0.1243 → '12.4%'. */
export const fmtPct = (f: number, dp = 1): string =>
  Number.isFinite(f) ? `${(f * 100).toFixed(dp)}%` : 'n/a'

export const fmtHf = (hf: number): string =>
  Number.isFinite(hf) ? hf.toFixed(hf < 1.1 ? 3 : 2) : 'no debt'

export const fmtBps = (bps: number): string =>
  Number.isFinite(bps) ? `${Math.round(bps)} bps` : 'n/a'

export function fmtDuration(s: number): string {
  if (!Number.isFinite(s)) return 'n/a'
  const a = Math.abs(s)
  if (a < 90) return `${Math.round(a)}s`
  if (a < 90 * 60) return `${Math.round(a / 60)}m`
  if (a < 48 * 3600) return `${(a / 3600).toFixed(1)}h`
  return `${(a / 86400).toFixed(1)}d`
}
