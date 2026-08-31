// Pure helpers + copy constants, kept OUT of atoms.tsx.
//
// A .tsx file that exports non-components defeats Fast Refresh: React cannot
// preserve component state across edits when the module's exports are mixed
// (react-doctor: only-export-components).

/** The four states the "Cured" column can take. Defined once, used everywhere. */
export const CURE_LEGEND =
  'Did the price recover enough to bring the account back under its own liquidation ' +
  'line inside Membrane’s 8-hour cure window? Aave grants no such window — its ' +
  'liquidation is atomic, in the same block. ' +
  'yes = recovered and still healthy at hour 8. ' +
  '8h = recovered, then breached again before hour 8. ' +
  'no = never recovered. ' +
  '— = the Oct 10 oracle series cannot price this collateral.'

export const usd = (n: number): string => {
  const abs = Math.abs(n)
  if (abs >= 1e9) return `$${(n / 1e9).toFixed(2)}B`
  if (abs >= 1e6) return `$${(n / 1e6).toFixed(1)}M`
  if (abs >= 1e3) return `$${(n / 1e3).toFixed(0)}k`
  return `$${n.toFixed(0)}`
}

export const pct = (frac: number, dp = 1): string => `${(frac * 100).toFixed(dp)}%`
