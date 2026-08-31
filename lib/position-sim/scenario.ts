/**
 * Loads the committed Oct 10 2025 price path and turns it into a `PricePath`.
 *
 * Everything here is MEASURED data read from public/data/oct10-2025/, produced by
 * scripts/build-oct10-dataset.ts. Nothing is synthesised. Gaps stay null.
 */

import { stamp, type PricePath, type Provenance } from './types'

export interface Oct10Series {
  startTs: number
  stepSeconds: number
  count: number
  columns: Record<string, (number | null)[]>
  carried: Record<string, number[]>
}

export interface Oct10Manifest {
  name: string
  windowStartUtc: string
  windowEndUtc: string
  resolution: string
  sources: { series: string; source: string; file: string }[]
  caveats: string[]
}

export const OCT10_DATA_PATH = '/data/oct10-2025'

/**
 * Which measured series prices which asset symbol.
 *
 * ORACLE, NOT SPOT: liquidations fire off the oracle, so the oracle column is the
 * correct input. The dataset's own finding is that using spot instead would fire
 * ETH liquidations late (the ETH oracle printed 0.70% BELOW the spot trough) and BTC
 * liquidations early (the BTC oracle bottomed 4 min late and 1.14% above spot).
 *
 * A symbol absent from this map is NOT priced — it is held flat and reported in
 * `Comparison.unpricedSymbols` rather than being silently approximated.
 */
export const SYMBOL_TO_SERIES: Record<string, string> = {
  WETH: 'ethOracle',
  ETH: 'ethOracle',
  WBTC: 'btcOracle',
  cbBTC: 'btcOracle',
  USDe: 'usdeSpot',
}

/** Stablecoins we hold at $1 across the window, and say so. USDe is NOT here — it
 *  is the one that actually moved, and it has a measured series. */
export const HELD_AT_ONE = ['USDC', 'USDT', 'DAI', 'USDS', 'GHO', 'sDAI', 'sUSDS']

let cache: { series: Oct10Series; manifest: Oct10Manifest } | null = null

export async function loadOct10(): Promise<{ series: Oct10Series; manifest: Oct10Manifest }> {
  if (cache) return cache
  const [sRes, mRes] = await Promise.all([
    fetch(`${OCT10_DATA_PATH}/prices-1m.json`),
    fetch(`${OCT10_DATA_PATH}/manifest.json`),
  ])
  if (!sRes.ok) throw new Error(`Could not load the Oct 10 price data (HTTP ${sRes.status}).`)
  if (!mRes.ok) throw new Error(`Could not load the Oct 10 manifest (HTTP ${mRes.status}).`)
  const series = (await sRes.json()) as Oct10Series
  const manifest = (await mRes.json()) as Oct10Manifest
  cache = { series, manifest }
  return cache
}

export function oct10Provenance(manifest: Oct10Manifest): Provenance {
  return stamp(
    'dataset',
    'measured Oct 10 2025 · 1m candles',
    `${manifest.windowStartUtc} → ${manifest.windowEndUtc}, Chainlink oracle rounds + Binance 1m klines, read from public JSON-RPC. ${manifest.caveats.length} recorded caveats.`,
    Date.parse(manifest.windowStartUtc),
  )
}

/**
 * Builds a price path covering exactly the symbols asked for.
 * Returns the path plus the list of symbols it could not price.
 */
export function buildPricePath(
  series: Oct10Series,
  manifest: Oct10Manifest,
  symbols: string[],
): { path: PricePath; unpriced: string[] } {
  const out: Record<string, (number | null)[]> = {}
  const unpriced: string[] = []
  const flat = (v: number) => new Array<number | null>(series.count).fill(v)

  for (const sym of Array.from(new Set(symbols))) {
    const col = SYMBOL_TO_SERIES[sym]
    if (col && series.columns[col]) {
      out[sym] = series.columns[col]
    } else if (HELD_AT_ONE.includes(sym)) {
      out[sym] = flat(1)
    } else {
      unpriced.push(sym)
    }
  }
  return {
    path: {
      startTs: series.startTs,
      stepSeconds: series.stepSeconds,
      count: series.count,
      series: out,
      provenance: oct10Provenance(manifest),
    },
    unpriced,
  }
}

/** Forward-fills only for READING a series — the stored data keeps its gaps. */
export function priceAt(path: PricePath, symbol: string, i: number): number | null {
  const s = path.series[symbol]
  if (!s) return null
  for (let k = i; k >= 0; k--) {
    if (s[k] !== null) return s[k]
  }
  return null
}
