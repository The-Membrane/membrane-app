/**
 * PRIMARY COLLATERAL CLUSTER — the group a position is drawn in on the wavefront.
 *
 * RULE. A position's cluster comes from its LARGEST collateral leg by USD at t0 (block-N
 * oracle prices). For a Morpho position that is its one collateral token.
 *
 *   ETH      WETH / ETH and the ETH liquid-staking and restaking receipts (`ETH_SYMBOLS`)
 *   BTC      wrapped and bridged bitcoin (`BTC_SYMBOLS`)
 *   OP, ARB, LINK, AAVE   the token itself
 *   Stables  the shared stable definition, collateralClass.ts `isStable` — the same list that
 *            decides the no-delay class, so the two can never disagree
 *   <symbol> any other symbol that is the primary leg of at least OWN_CLUSTER_MIN_POSITIONS
 *            positions across the whole census (Aave and Morpho together), e.g. Mog
 *   Other    everything else
 *
 * The symbol is the token's own on-chain symbol (Aave: the reserve's symbol from the oracle
 * pull; Morpho: the CSV's collateral_symbol). Matching is exact — "BITCOIN" on mainnet Morpho
 * is a meme token (HarryPotterObamaSonic10Inu), not bitcoin, and lands in Other.
 */

import { isStable } from '../position-sim/collateralClass'

export const ETH_SYMBOLS: readonly string[] = [
  'WETH',
  'ETH',
  'stETH',
  'wstETH',
  'weETH',
  'rETH',
  'cbETH',
  'ETHx',
  'osETH',
  'tETH',
  'rsETH',
  'wrsETH',
  'ezETH',
  'superOETHb',
  'wsuperOETHb',
  'bsdETH',
  'ETH+',
  'ETH0',
]

export const BTC_SYMBOLS: readonly string[] = [
  'WBTC',
  'BTC',
  'cbBTC',
  'tBTC',
  'LBTC',
  'eBTC',
  'FBTC',
]

/** Named one-token clusters. */
export const NAMED_CLUSTERS: readonly string[] = ['OP', 'ARB', 'LINK', 'AAVE']

/** A symbol outside the named clusters gets its own cluster at this many positions. */
export const OWN_CLUSTER_MIN_POSITIONS = 20

const ETH = new Set(ETH_SYMBOLS)
const BTC = new Set(BTC_SYMBOLS)
const NAMED = new Set(NAMED_CLUSTERS)

/** The cluster a symbol belongs to by rule alone, or null when it depends on the counts. */
export function fixedClusterOf(symbol: string): string | null {
  if (ETH.has(symbol)) return 'ETH'
  if (BTC.has(symbol)) return 'BTC'
  if (NAMED.has(symbol)) return symbol
  if (isStable(symbol)) return 'Stables'
  return null
}

/**
 * Build the census's cluster function from the primary-leg symbol of EVERY position. A symbol
 * that is not in a fixed cluster gets its own cluster when it is the primary leg of at least
 * `minPositions` positions; otherwise it is Other.
 */
export function clusterAssigner(
  primarySymbols: readonly string[],
  minPositions = OWN_CLUSTER_MIN_POSITIONS,
): { clusterOf: (symbol: string) => string; ownClusters: string[] } {
  const counts = new Map<string, number>()
  for (const s of primarySymbols) {
    if (fixedClusterOf(s) === null) counts.set(s, (counts.get(s) ?? 0) + 1)
  }
  const own = new Set([...counts].filter(([, n]) => n >= minPositions).map(([s]) => s))
  return {
    clusterOf: (symbol: string) => fixedClusterOf(symbol) ?? (own.has(symbol) ? symbol : 'Other'),
    ownClusters: [...own].sort(),
  }
}

/** The primary (largest by USD) leg's symbol. Ties keep the first leg. */
export function primarySymbol(legs: readonly { symbol: string; usd: number | null }[]): string {
  let best: { symbol: string; usd: number | null } | null = null
  for (const l of legs) {
    if (best === null || (l.usd ?? -Infinity) > (best.usd ?? -Infinity)) best = l
  }
  return best ? best.symbol : 'Other'
}
