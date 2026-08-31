// Number formatting for the position simulator. Every figure on this surface goes
// through here so the same value never prints two ways in two blocks.

/** Signed USD, whole dollars. Uses a real minus sign, not a hyphen. */
export const usd = (n: number): string => {
  if (!Number.isFinite(n)) return '—'
  const sign = n < 0 ? '−' : ''
  return `${sign}$${Math.abs(Math.round(n)).toLocaleString('en-US')}`
}

/** USD with an explicit + on positive values — for deltas only. */
export const usdSigned = (n: number): string => (n > 0 ? `+${usd(n)}` : usd(n))

/** A 0–1 ratio as a percentage. */
export const pct = (n: number, dp = 1): string =>
  Number.isFinite(n) ? `${(n * 100).toFixed(dp)}%` : '—'

/** Token amount — enough places to be recognisable, never more than the data has. */
export const amt = (n: number): string =>
  Number.isFinite(n)
    ? n.toLocaleString('en-US', { maximumFractionDigits: n >= 1000 ? 0 : n >= 1 ? 4 : 8 })
    : '—'

/** UTC clock for a price-path minute. The dataset is a UTC window, so it prints UTC. */
export const utcClock = (ts: number): string => {
  const d = new Date(ts * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  const day = String(d.getUTCDate()).padStart(2, '0')
  return `${day} ${hh}:${mm}Z`
}

/** Short address for headers. */
export const shortAddress = (a: string): string =>
  a.length > 12 ? `${a.slice(0, 6)}…${a.slice(-4)}` : a
