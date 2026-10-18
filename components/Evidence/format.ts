// Pure helpers + copy constants, kept OUT of atoms.tsx.
//
// A .tsx file that exports non-components defeats Fast Refresh: React cannot
// preserve component state across edits when the module's exports are mixed
// (react-doctor: only-export-components).

/** The four states the "Cured" column can take. Defined once, used everywhere. */
export const CURE_LEGEND =
  'Did the price alone bring the position back under its own liquidation line inside ' +
  'Membrane’s 8-hour window? The protocols grant no such window — their liquidation is ' +
  'atomic, in the same block. Each leg moves on its own protocol’s oracle. ' +
  'yes = back under the line and still under it at hour 8. ' +
  '8h = back under the line, then over it again by hour 8. ' +
  'no = never back under the line. ' +
  '— = no window to cure in (stablecoin collateral, or a line above 90%), or no minute left in the data.'

export const usd = (n: number): string => {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}k`
  return `$${n.toFixed(0)}`
}

export const pct = (frac: number, dp = 1): string => `${(frac * 100).toFixed(dp)}%`

/** "16.5% less" / "4.2% more" from a gap percentage (positive = Membrane closes less). */
export const gapWord = (gapPct: number, dp = 1): string =>
  `${Math.abs(gapPct).toFixed(dp)}% ${gapPct >= 0 ? 'less' : 'more'}`

/** Display names. The census keys stay the data's own. */
export const PROTOCOL_NAME: Record<string, string> = {
  'aave-v3': 'Aave V3',
  'morpho-blue': 'Morpho Blue',
  aave: 'Aave V3',
  morpho: 'Morpho Blue',
}
export const CHAIN_NAME: Record<string, string> = {
  mainnet: 'Ethereum',
  arbitrum: 'Arbitrum',
  optimism: 'Optimism',
  base: 'Base',
}

/** Grid minute (minute 0 = 00:00 UTC 10 Oct 2025) as "10 Oct 21:14 UTC". */
export const minuteClock = (minute: number): string => {
  const ts = Date.UTC(2025, 9, 10) + minute * 60_000
  const d = new Date(ts)
  const hh = String(d.getUTCHours()).padStart(2, '0')
  const mm = String(d.getUTCMinutes()).padStart(2, '0')
  return `${d.getUTCDate()} Oct ${hh}:${mm} UTC`
}

/** Grid-end marker used in the table and its legend. */
export const GRID_END_MARK = '◐'

/** "17.9 pp less" / "4.2 pp more": a share gap in percentage points (positive = Membrane closes a
 *  smaller share of its own debt). */
export const ppWord = (gapPp: number, dp = 1): string =>
  `${Math.abs(gapPp).toFixed(dp)} pp ${gapPp >= 0 ? 'less' : 'more'}`

/** "31.2%" from a share. */
export const share = (x: number, dp = 1): string => `${(x * 100).toFixed(dp)}%`
