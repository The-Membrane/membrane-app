/**
 * Token amounts for execution: the lever's DISPLAY amount, converted once, exactly, into
 * the token's own integer units. No float arithmetic touches the result.
 *
 * The lever row (lib/position/reverseSolve.ts) carries `amount`, a multiple of its step,
 * and `amountDecimals`, the decimals that step prints at. The reader sees
 * fmtAmount(amount, amountDecimals), e.g. "460" or "0.29". That same decimal string,
 * without grouping, is what parseUnits reads at the token's decimals: "460" at 6 decimals
 * is 460000000, "0.29" at 18 is 290000000000000000. A display with more decimals than
 * the token has would need rounding, so it throws instead.
 */

import { formatUnits, parseUnits } from 'viem'

/** The decimal string the lever prints, without grouping: "460", "0.29". */
export function leverDecimalString(amount: number, amountDecimals: number): string {
  if (!Number.isInteger(amountDecimals) || amountDecimals < 0 || amountDecimals > 20) {
    throw new Error(`lever amount: display decimals ${amountDecimals} is not an integer in 0–20`)
  }
  if (!Number.isFinite(amount) || !(amount > 0))
    throw new Error(`lever amount: ${amount} is not a positive number`)
  // toFixed switches to exponent notation at 1e21; no lever amount is near that.
  if (amount >= 1e21) throw new Error(`lever amount: ${amount} is too large to print exactly`)
  return amount.toFixed(amountDecimals)
}

/**
 * The lever's amount in the token's integer units. Throws when the display has more
 * fractional digits than the token (that would round), or when the result is zero.
 */
export function leverUnits(amount: number, amountDecimals: number, tokenDecimals: number): bigint {
  if (!Number.isInteger(tokenDecimals) || tokenDecimals < 0 || tokenDecimals > 36) {
    throw new Error(`lever amount: token decimals ${tokenDecimals} is not an integer in 0–36`)
  }
  const text = leverDecimalString(amount, amountDecimals)
  const frac = text.split('.')[1] ?? ''
  if (frac.length > tokenDecimals) {
    throw new Error(`lever amount: ${text} has more decimals than the token's ${tokenDecimals}`)
  }
  const units = parseUnits(text, tokenDecimals)
  if (units <= 0n) throw new Error(`lever amount: ${text} is zero in token units`)
  return units
}

/**
 * Integer token units printed with grouping, cut DOWN to `shown` decimals: a balance is
 * never shown larger than it is. 12400520000 at 6 decimals, shown 2 → "12,400.52".
 */
export function fmtUnits(units: bigint, decimals: number, shown: number): string {
  const negative = units < 0n
  const abs = negative ? -units : units
  const [whole, frac = ''] = formatUnits(abs, decimals).split('.')
  const grouped = whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')
  const cut = frac.padEnd(shown, '0').slice(0, shown)
  return `${negative ? '−' : ''}${grouped}${shown > 0 ? `.${cut}` : ''}`
}
