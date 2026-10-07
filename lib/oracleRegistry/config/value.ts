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

/** Sort comparator: the highest value at risk first; an unknown value last. */
export function compareValueAtRisk(
  a: Pick<ValueAtRisk, 'usd'> | null | undefined,
  b: Pick<ValueAtRisk, 'usd'> | null | undefined,
): number {
  const x = a?.usd ?? null
  const y = b?.usd ?? null
  if (x === null && y === null) return 0
  if (x === null) return 1
  if (y === null) return -1
  return y - x
}

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

/** One-line label of a value at risk: "$300M at risk (locked on Ethereum)" or why it is unknown. */
export function valueAtRiskLabel(v: ValueAtRisk | null | undefined): string {
  if (!v) return 'value at risk not read'
  if (v.usd === null) return `value at risk unknown (${v.unread.join('; ') || 'not read'})`
  const basis = v.basis === 'locked' ? 'locked on Ethereum' : 'bridged supply on the remote chain'
  return `${formatUsdCompact(v.usd)} at risk (${basis})${v.unread.length ? ` · lower bound: ${v.unread.join('; ')}` : ''}`
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
