/** Formatting for the wavefront page. Every figure renders in mono; these only make strings. */

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

export const fmtInt = (n: number) => Math.round(n).toLocaleString('en-US')

/** $ to three significant figures: $840, $45.6K, $1.23M, $186M. */
export function fmtUsd(x: number): string {
  const v = Math.abs(x)
  const sign = x < 0 ? '−' : ''
  if (v < 999.5) return `${sign}$${Math.round(v)}`
  const units: [number, string][] = [
    [1e3, 'K'],
    [1e6, 'M'],
    [1e9, 'B'],
  ]
  for (let i = 0; i < units.length; i++) {
    const [div, suffix] = units[i]
    const scaled = Number((v / div).toPrecision(3))
    if (scaled < 1000 || i === units.length - 1) return `${sign}$${scaled}${suffix}`
  }
  return `${sign}$${v}`
}

/**
 * A share as a percentage, floored to 0.1 so it never overstates (99.97% → 99.9%); a whole
 * number prints without the decimal (100%).
 */
export function fmtPctFloor(part: number, whole: number): string {
  if (whole <= 0) return '0%'
  const v = Math.floor((part / whole) * 1000) / 10
  return `${Number.isInteger(v) ? v : v.toFixed(1)}%`
}

/** "Oct 10 21:30 UTC". */
export function fmtClock(ts: number): string {
  const d = new Date(ts * 1000)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()} ${hh}:${mm} UTC`
}

/** "21:30". */
export function fmtHm(ts: number): string {
  const d = new Date(ts * 1000)
  return `${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')}`
}

/** "Oct 10–11, 2025" for a window [startTs, endTs). */
export function fmtWindow(startTs: number, endTs: number): string {
  const a = new Date(startTs * 1000)
  const b = new Date((endTs - 1) * 1000)
  const y = a.getUTCFullYear()
  if (a.getUTCFullYear() === b.getUTCFullYear() && a.getUTCMonth() === b.getUTCMonth()) {
    const days =
      a.getUTCDate() === b.getUTCDate()
        ? `${a.getUTCDate()}`
        : `${a.getUTCDate()}–${b.getUTCDate()}`
    return `${MONTHS[a.getUTCMonth()]} ${days}, ${y}`
  }
  return `${MONTHS[a.getUTCMonth()]} ${a.getUTCDate()} – ${MONTHS[b.getUTCMonth()]} ${b.getUTCDate()}, ${b.getUTCFullYear()}`
}

/** Reader names for the stream's protocol and chain ids. */
const NAMES: Record<string, string> = {
  'aave-v3': 'Aave V3',
  'morpho-blue': 'Morpho Blue',
  mainnet: 'Ethereum',
  ethereum: 'Ethereum',
  base: 'Base',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
}
export const displayName = (id: string) => NAMES[id] ?? id.charAt(0).toUpperCase() + id.slice(1)

/** Ethereum first, then the rest alphabetically — the order the census docs use. */
export function chainList(ids: Iterable<string>): string {
  const names = [...ids].map(displayName)
  return names
    .sort((a, b) => (a === 'Ethereum' ? -1 : b === 'Ethereum' ? 1 : a.localeCompare(b)))
    .join(', ')
}

/** Parse a ?t= value: ISO time or unix seconds. */
export function parseTimeParam(v: unknown): number | null {
  if (typeof v !== 'string' || !v) return null
  if (/^\d{9,11}$/.test(v)) return Number(v)
  const ms = Date.parse(v)
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null
}

/**
 * "6 not compared: not liquidatable when rechecked" — the largest reasons, on one line. A
 * non-breaking space when every position is compared, so the line keeps its height.
 */
export function notComparedLine(nc: {
  count: number
  reasons: { reason: string; count: number }[]
}): string {
  const { count, reasons } = nc
  if (count <= 0) return '\u00a0'
  if (reasons.length <= 1) {
    return `${fmtInt(count)} not compared: ${reasons[0]?.reason ?? 'not simulated yet'}`
  }
  const shown = reasons.slice(0, 2).map((r) => `${fmtInt(r.count)} ${r.reason}`)
  const rest = reasons.slice(2).reduce((s, r) => s + r.count, 0)
  return `${fmtInt(count)} not compared: ${shown.join(' · ')}${rest ? ` · ${fmtInt(rest)} other` : ''}`
}
