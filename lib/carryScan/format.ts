/**
 * Display helpers for the carry scout, shared by the page and the tests. Client-safe.
 *
 * COPY RULES: Membrane's charge is never written as 0%, $0 or "free"; with no share given
 * (b) is a ceiling, "≤ x% · curator-set". A carry figure is the spread measured at the
 * last scan, never a promise.
 */

import type { Carry } from './types'

/** Fraction → "4.37%", real minus sign. */
export const pct = (v: number | null | undefined, dp = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const s = `${(Math.abs(v) * 100).toFixed(dp)}%`
  return v < 0 ? `−${s}` : s
}

/** Fraction → "+2.44pp" / "−0.31pp" (a spread). */
export const spread = (v: number | null | undefined, dp = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const s = `${(Math.abs(v) * 100).toFixed(dp)}pp`
  return v < 0 ? `−${s}` : `+${s}`
}

/** The `appSha` suffix for a scan run from a work tree with tracked changes (./appSha.ts). */
export const DIRTY_SUFFIX = '-dirty'

/** The `appSha` stamp as the page prints it: 8 characters, keeping a `-dirty` suffix. */
export function shortAppSha(sha: string | null | undefined): string | null {
  if (!sha) return null
  return `${sha.slice(0, 8)}${sha.endsWith(DIRTY_SUFFIX) ? DIRTY_SUFFIX : ''}`
}

export const sizeLabel = (n: number): string => (n >= 1e6 ? `$${n / 1e6}M` : `$${n / 1e3}K`)

export const usdCompact = (n: number): string =>
  n >= 1e9
    ? `$${(n / 1e9).toFixed(2)}B`
    : n >= 1e6
      ? `$${(n / 1e6).toFixed(1)}M`
      : `$${Math.round(n / 1e3)}K`

/**
 * (b) for display. Upper bound (no share given): "≤ 4.21% · curator-set". With what-if
 * shares: "4.21% · what-if shares". A value that would round to nothing prints "—", so a
 * zero never appears next to Membrane's name.
 */
export function formatCarryB(c: Carry | null | undefined): string {
  if (!c || c.apy === null || !Number.isFinite(c.apy) || c.apy < 0.00005) return '—'
  return c.bound === 'upper' ? `≤ ${pct(c.apy)} · curator-set` : `${pct(c.apy)} · what-if shares`
}

/**
 * A rendered string that would state a zero or "free" charge. Anchored so that "10%" or
 * "4.30%" do not match: only a standalone 0 / 0.00% / $0 / "free".
 */
export const ZERO_OR_FREE = /(?<![\d.])0(?:\.0+)?%|\$0(?![.,]?\d*[1-9])|\bfree\b/i

/**
 * A what-if share typed as a percent. Blank = not given (curator-set). A share must be in
 * (0, 100]%: 0 is refused, because it would print as a 0% Membrane charge.
 */
export function parseSharePct(text: string): { value?: number; error?: string } {
  const t = text.trim().replace(/%$/, '')
  if (t === '') return {}
  const n = Number(t)
  if (!Number.isFinite(n) || n <= 0 || n > 100)
    return { error: 'a share must be above 0 and at most 100%; leave it blank to show curator-set' }
  return { value: n / 100 }
}
