/**
 * THE SLIP'S AMOUNT FIELD. Pure: the reader's text in, the exact token units (or the named
 * reason it cannot be sent) out. Owner, Q27 round 5: "prevent errors before pay" — the
 * field cannot go past what the wallet holds, the debt a repay can pay or the room under
 * a supply cap (gates.ts amountLimit), and it says that limit inline with a Max chip. The
 * slip's blocking gates stay as the backstop.
 *
 *   ""          → empty            the field is cleared: nothing to re-read
 *   "8.5"       → ok               units at the token's decimals, exactly (parseUnits)
 *   "8.1234567" → too precise      more decimals than the token has: it would round
 *   "0"         → zero
 *   "9" > limit → over             names the limit ("Wallet holds 8.91 USDT")
 */

import { parseUnits } from 'viem'

import type { AmountLimit } from './gates'

export type AmountCheck =
  | { kind: 'ok'; units: bigint; amount: number; amountDecimals: number; text: string }
  | { kind: 'empty' }
  | { kind: 'error'; message: string }

const NUMBER = /^(\d+)(?:\.(\d*))?$/

/** The reader's typed amount, checked against the token's decimals and the limit. */
export function checkAmount(raw: string, decimals: number, limit: AmountLimit | null): AmountCheck {
  // Grouping commas and spaces are how the slip prints amounts; accept them back.
  const text = raw.replace(/[,\s_]/g, '')
  if (text === '') return { kind: 'empty' }
  const m = NUMBER.exec(text.startsWith('.') ? `0${text}` : text)
  if (!m) return { kind: 'error', message: 'Type a number, like 250 or 0.25' }
  const frac = (m[2] ?? '').replace(/0+$/, '')
  if (frac.length > decimals)
    return { kind: 'error', message: `At most ${decimals} decimals for this token` }
  const clean = frac ? `${m[1]}.${frac}` : m[1]
  const units = parseUnits(clean, decimals)
  if (units <= 0n) return { kind: 'error', message: 'Type an amount above 0' }
  if (limit && units > limit.units) return { kind: 'error', message: `More than the limit: ${limit.text}` }
  return { kind: 'ok', units, amount: Number(clean), amountDecimals: frac.length, text: clean }
}

/**
 * The limit as a typed amount, cut DOWN to `shown` decimals so a Max never exceeds what
 * is there ("8.91" for 8,912,940 units at 6 decimals, shown 2). Null when that is zero.
 */
export function maxText(limit: AmountLimit, decimals: number, shown: number): string | null {
  const s = Math.min(shown, decimals)
  const step = 10n ** BigInt(decimals - s)
  const cut = (limit.units / step) * step
  if (cut <= 0n) return null
  const whole = cut / 10n ** BigInt(decimals)
  const frac = (cut % 10n ** BigInt(decimals)).toString().padStart(decimals, '0').slice(0, s)
  const trimmed = frac.replace(/0+$/, '')
  return trimmed ? `${whole}.${trimmed}` : `${whole}`
}
