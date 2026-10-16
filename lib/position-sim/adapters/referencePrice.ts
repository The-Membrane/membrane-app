/**
 * An INDEPENDENT USD price for a token, used only to sanity-check a protocol's own oracle.
 * Never a price any figure is computed from.
 *
 * Why: a Morpho market's oracle is whatever the market creator deployed. One mainnet WETH/USDC
 * market quotes WETH at ~$4.7T (2026-10-16); valued by it, a 0.001 WETH position shows a
 * liquidation line at $111B and an ETH forecast against it. Comparing the oracle's USD price
 * with a market reference catches that without second-guessing an honest oracle: the band is
 * the same 0.5–2× Compound V3's base check uses (compoundV3.ts USD_BAND), wide enough for
 * any depeg or exchange-rate drift and ~1,000× narrower than a unit mistake.
 *
 * Sources, in order: the Aave V3 oracle at the read's block (the caller passes those prices),
 * then DefiLlama's keyless current-price API for tokens Aave does not list. DefiLlama sees
 * only token addresses, never the reader's address.
 */

import type { OracleCheck } from '../types'

/** Oracle USD / reference USD outside this band → 'disagrees'. Compound V3's USD_BAND. */
export const ORACLE_REFERENCE_BAND = { min: 0.5, max: 2 } as const

export const DEFILLAMA_PRICES_URL = 'https://coins.llama.fi/prices/current/'
export const DEFILLAMA_TIMEOUT_MS = 5_000

/** DefiLlama current USD prices by lowercased address; `error` says why some are missing. */
export async function defillamaUsdPrices(
  tokens: `0x${string}`[],
  fetchImpl: typeof fetch,
  timeoutMs: number = DEFILLAMA_TIMEOUT_MS,
): Promise<{ prices: Record<string, number>; error: string | null }> {
  if (tokens.length === 0) return { prices: {}, error: null }
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null
  let timer: ReturnType<typeof setTimeout> | undefined
  // A reference that does not come back in time is no reference: the check says 'unchecked'.
  const timeout = new Promise<{ prices: Record<string, number>; error: string }>((resolve) => {
    timer = setTimeout(() => {
      controller?.abort()
      resolve({ prices: {}, error: `DefiLlama no answer in ${timeoutMs / 1000} s` })
    }, timeoutMs)
  })
  const read = (async () => {
    try {
      const keys = tokens.map((t) => `ethereum:${t.toLowerCase()}`)
      const res = await fetchImpl(`${DEFILLAMA_PRICES_URL}${keys.join(',')}`, controller ? { signal: controller.signal } : {})
      if (!res.ok) return { prices: {}, error: `DefiLlama HTTP ${res.status}` }
      const body = (await res.json()) as { coins?: Record<string, { price?: number }> }
      const prices: Record<string, number> = {}
      for (const [key, coin] of Object.entries(body.coins ?? {})) {
        const addr = key.split(':')[1]?.toLowerCase()
        if (addr && typeof coin.price === 'number' && coin.price > 0) prices[addr] = coin.price
      }
      return { prices, error: null }
    } catch (e) {
      return { prices: {}, error: `DefiLlama ${(e as Error).message}` }
    }
  })()
  try {
    return await Promise.race([read, timeout])
  } finally {
    clearTimeout(timer)
  }
}

/** The verdict on one oracle price against its reference (null = none was found). */
export function checkOracle(
  input: Omit<OracleCheck, 'status' | 'ratio' | 'band'>,
): OracleCheck {
  const band = { min: ORACLE_REFERENCE_BAND.min, max: ORACLE_REFERENCE_BAND.max }
  const ref = input.referenceUsd
  if (ref === null || !(ref > 0)) return { ...input, referenceUsd: null, status: 'unchecked', ratio: null, band }
  const ratio = input.oraclePriceUsd / ref
  return { ...input, status: ratio >= band.min && ratio <= band.max ? 'ok' : 'disagrees', ratio, band }
}

/** "oracle price disagrees with market: $4.7e12 vs $2,413 (Aave V3 oracle)" — one line. */
export function oracleCheckNote(c: OracleCheck): string {
  const usd = (x: number) =>
    x >= 1e9 ? `$${x.toExponential(2)}` : `$${x.toLocaleString('en-US', { maximumSignificantDigits: 6 })}`
  if (c.status === 'unchecked') {
    return `oracle price unchecked: no market reference for ${c.symbol}${c.referenceSource ? ` (${c.referenceSource})` : ''}`
  }
  const verdict = c.status === 'ok' ? 'oracle price agrees with market' : 'oracle price disagrees with market'
  return `${verdict}: ${c.symbol} ${usd(c.oraclePriceUsd)} by the oracle vs ${usd(c.referenceUsd as number)} (${c.referenceSource})`
}
