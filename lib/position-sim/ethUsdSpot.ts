/**
 * ethUsdSpot — the live ETH/USD price: Chainlink's mainnet ETH/USD feed, `latestRoundData()`
 * through the proxy (chainlinkFeeds.ts FEEDS.ETH_USD). The Risk Frontier spec names this source
 * (docs/RISK_FRONTIER_DESIGN.md §4 MARKET, "Chainlink spot"). The exit readout needs it to
 * price a WETH venue's cash (exitReadout.ts).
 *
 * FRESHNESS: the feed updates on a 0.5% move or a 1 h heartbeat. A round older than
 * MEASURED_STALE_CADENCES (2) × that heartbeat is stale (measuredCapacity.ts rule 3, the
 * same 2 h the exit readout's 'now' reading gets). A stale price is withheld, never shown as
 * live (design spec §5, board design rules §4).
 *
 * A round with answer ≤ 0 or no update time is refused (null), never read as $0.
 */

import type { PublicClient } from 'viem'

import { FEEDS } from './chainlinkFeeds'
import { MEASURED_STALE_CADENCES } from './measuredCapacity'
import { getMainnetClient } from './rpc'

export const ETH_USD_FEED = FEEDS.ETH_USD

export const ETH_USD_SOURCE = 'Chainlink ETH/USD'

/** The feed's heartbeat: it posts at least this often. */
export const ETH_USD_HEARTBEAT_MS = 3_600_000

/** Oldest a round may be and still count as the price now. Exactly the limit is fresh. */
export const ETH_USD_MAX_AGE_MS = MEASURED_STALE_CADENCES * ETH_USD_HEARTBEAT_MS

export interface EthUsdSpot {
  readonly priceUsd: number
  /** The round's `updatedAt`, ms since epoch. */
  readonly updatedAtMs: number
  readonly roundId: bigint
  readonly source: typeof ETH_USD_SOURCE
}

const AGGREGATOR_V3_ABI = [
  {
    type: 'function',
    name: 'latestRoundData',
    stateMutability: 'view',
    inputs: [],
    outputs: [
      { name: 'roundId', type: 'uint80' },
      { name: 'answer', type: 'int256' },
      { name: 'startedAt', type: 'uint256' },
      { name: 'updatedAt', type: 'uint256' },
      { name: 'answeredInRound', type: 'uint80' },
    ],
  },
  {
    type: 'function',
    name: 'decimals',
    stateMutability: 'view',
    inputs: [],
    outputs: [{ type: 'uint8' }],
  },
] as const

/** A `latestRoundData()` result → the spot price; null for a round that carries no price. */
export function decodeEthUsdRound(
  round: readonly [bigint, bigint, bigint, bigint, bigint],
  decimals: number,
): EthUsdSpot | null {
  const [roundId, answer, , updatedAt] = round
  if (answer <= 0n || updatedAt <= 0n) return null
  if (!(Number.isInteger(decimals) && decimals >= 0 && decimals <= 36)) return null
  return {
    priceUsd: Number(answer) / 10 ** decimals,
    updatedAtMs: Number(updatedAt) * 1000,
    roundId,
    source: ETH_USD_SOURCE,
  }
}

/** Age of a round at `nowMs`, ms. */
export function ethUsdAgeMs(spot: EthUsdSpot, nowMs: number): number {
  return nowMs - spot.updatedAtMs
}

/** The round still counts as the price now: not older than ETH_USD_MAX_AGE_MS, not later
 *  than `nowMs`. */
export function ethUsdFresh(spot: EthUsdSpot, nowMs: number): boolean {
  const age = ethUsdAgeMs(spot, nowMs)
  return age >= 0 && age <= ETH_USD_MAX_AGE_MS
}

/** Read the live price. Throws when the feed returns no price (never a silent $0). */
export async function readEthUsdSpot(
  client: PublicClient = getMainnetClient(),
): Promise<EthUsdSpot> {
  const [round, decimals] = await Promise.all([
    client.readContract({
      address: ETH_USD_FEED,
      abi: AGGREGATOR_V3_ABI,
      functionName: 'latestRoundData',
    }),
    client.readContract({
      address: ETH_USD_FEED,
      abi: AGGREGATOR_V3_ABI,
      functionName: 'decimals',
    }),
  ])
  const spot = decodeEthUsdRound(round, decimals)
  if (!spot) throw new Error(`${ETH_USD_SOURCE}: latestRoundData returned no price`)
  return spot
}
