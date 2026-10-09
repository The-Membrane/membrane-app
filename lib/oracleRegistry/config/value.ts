// Severity rank of floor breaches (owner rulings 2026-10-06, #5 and round 2 #9): the USD value
// behind a bridge route, so the worst breaches surface first.
//
//   value at risk = max(Ethereum adapter locked balance, remote-chain bridged supply)
//
// priced in USD with the oracle registry's consensus for the token's catalog asset (times an
// on-chain rate when the token is not itself a catalog asset: rsETH = ETH × rsETH/ETH). A forged
// inbound message on Ethereum releases what the adapter holds; a forged message on the remote
// side mints there, up to what that chain's supply can be swapped for. Pure: the collector reads
// the balances and the consensus; nothing here touches the network.

import type { ValueAtRisk } from './types'

export type { ValueAtRisk } from './types'

/** A raw token amount with its decimals (as read on-chain). */
export type Amount = { raw: string; decimals: number }

export function amountToNumber(a: Amount | null | undefined): number | null {
  if (!a) return null
  try {
    const raw = BigInt(a.raw)
    if (raw < 0n || !Number.isInteger(a.decimals) || a.decimals < 0) return null
    const scale = 10n ** BigInt(a.decimals)
    // integer part exactly, fraction to 1e-6 (USD values are shown to 3 significant digits)
    return Number(raw / scale) + Number(((raw % scale) * 1_000_000n) / scale) / 1_000_000
  } catch {
    return null
  }
}

export function valueAtRisk(inp: {
  locked: Amount | null
  remoteSupply: Amount | null
  priceUsd: number | null
  priceBasis: string
  unread?: string[]
}): ValueAtRisk {
  const unread = [...(inp.unread ?? [])]
  const price = inp.priceUsd !== null && Number.isFinite(inp.priceUsd) ? inp.priceUsd : null
  if (price === null) unread.push(`no price (${inp.priceBasis})`)
  const usd = (a: Amount | null) => {
    const n = amountToNumber(a)
    return n === null || price === null ? null : n * price
  }
  const lockedUsd = usd(inp.locked)
  const remoteSupplyUsd = usd(inp.remoteSupply)
  const both = [lockedUsd, remoteSupplyUsd].filter((x): x is number => x !== null)
  const max = both.length ? Math.max(...both) : null
  return {
    usd: max,
    lockedUsd,
    remoteSupplyUsd,
    basis:
      max === null ? null : lockedUsd !== null && lockedUsd >= max ? 'locked' : 'remote_supply',
    priceUsd: price,
    priceBasis: inp.priceBasis,
    unread,
  }
}

/**
 * Sort comparator for floor breaches: a value at risk that was NOT READ first (owner ruling
 * 2026-10-08, #14 — fail closed: an unread value could be the largest), then the highest value
 * first. Review round 9: a PARTIAL read (one side unread, `unread` non-empty) is unread too — the
 * value is the larger of the two sides (ruling #9), so with a side missing the value is not
 * known and could be the largest. Order: nothing read, then partial reads by the side that was
 * read (highest first), then fully read values (highest first). `unread` absent = fully read.
 */
export function compareValueAtRisk(
  a: (Pick<ValueAtRisk, 'usd'> & { unread?: readonly string[] }) | null | undefined,
  b: (Pick<ValueAtRisk, 'usd'> & { unread?: readonly string[] }) | null | undefined,
): number {
  const x = a?.usd ?? null
  const y = b?.usd ?? null
  // 0 = nothing read, 1 = partly read, 2 = fully read
  const tier = (usd: number | null, unread: readonly string[] | undefined) =>
    usd === null ? 0 : unread?.length ? 1 : 2
  const tx = tier(x, a?.unread)
  const ty = tier(y, b?.unread)
  if (tx !== ty) return tx - ty
  if (x === null || y === null) return 0
  return y - x
}

/** Is the value at risk not fully known (nothing read, or one side unread)? Review round 9. */
export const valueAtRiskUnread = (v: ValueAtRisk | null | undefined): boolean =>
  !v || v.usd === null || v.unread.length > 0

/** "$1.23B" · "$300M" · "$12.4K" · "$950" (three significant digits, trailing zeros dropped). */
export function formatUsdCompact(n: number): string {
  if (!Number.isFinite(n)) return '—'
  const units: [number, string][] = [
    [1, ''],
    [1e3, 'K'],
    [1e6, 'M'],
    [1e9, 'B'],
  ]
  const abs = Math.abs(n)
  let u = abs >= 1e9 ? 3 : abs >= 1e6 ? 2 : abs >= 1e3 ? 1 : 0
  const round = (i: number) => {
    const v = n / units[i][0]
    const digits = Math.abs(v) >= 100 ? 0 : Math.abs(v) >= 10 ? 1 : 2
    return Number(v.toFixed(digits))
  }
  let r = round(u)
  // $999.6M rounds to 1000: say "$1B", never "$1000M" (review round 5)
  if (Math.abs(r) >= 1000 && u < units.length - 1) r = round(++u)
  return `$${r}${units[u][1]}`
}

/**
 * One-line label of a value at risk: "$300M at risk (locked on Ethereum)", or "value unread"
 * and why (ruling #14: such a breach sorts first). A partial read is "value unread" too, with
 * the side that was read as a lower bound (review round 9).
 */
export function valueAtRiskLabel(v: ValueAtRisk | null | undefined): string {
  if (!v) return 'value unread (not read)'
  if (v.usd === null) return `value unread (${v.unread.join('; ') || 'not read'})`
  const basis = v.basis === 'locked' ? 'locked on Ethereum' : 'bridged supply on the remote chain'
  if (v.unread.length)
    return `value unread (${v.unread.join('; ')}) · at least ${formatUsdCompact(v.usd)} (${basis})`
  return `${formatUsdCompact(v.usd)} at risk (${basis})`
}

/** USD consensus of a registry asset × an optional on-chain rate (rsETH/ETH) → USD per token. */
export function tokenPriceUsd(
  consensusUsd: number | null,
  rate: Amount | null | undefined,
): number | null {
  if (consensusUsd === null || !Number.isFinite(consensusUsd)) return null
  if (rate === undefined) return consensusUsd
  const r = amountToNumber(rate)
  return r === null ? null : consensusUsd * r
}

/**
 * A mint/redeem parameter for display: an integer in base units of `unit` reads "30,000 wstETH"
 * (the stored value stays the raw integer, so the rules compare exactly). null = not an amount
 * (no unit, an address, a flag): the caller shows the value as stored.
 */
export function formatParamAmount(
  v: unknown,
  unit: { decimals: number; symbol: string } | undefined,
): string | null {
  if (!unit || (typeof v !== 'string' && typeof v !== 'number') || !/^\d+$/.test(String(v)))
    return null
  const n = amountToNumber({ raw: String(v), decimals: unit.decimals })
  return n === null
    ? null
    : `${n.toLocaleString('en-US', { maximumFractionDigits: 4 })} ${unit.symbol}`
}
