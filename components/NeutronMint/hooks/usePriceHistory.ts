import { useQuery } from '@tanstack/react-query'
import { DENOM_TO_COINGECKO, PriceHistoryByAsset, PriceHistoryData, TimeRange } from '../types'
import { getHistoricalOraclePrices } from '@/services/cdp'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'

const COINGECKO_API = 'https://api.coingecko.com/api/v3'

// Toggle to switch between CoinGecko and CDP historical oracle prices
// Set to true to use CDP contract's HISTORICAL_ORACLE_PRICES
// Set to false to use CoinGecko API (default)
export const USE_CDP_HISTORICAL_PRICES = false

// Delay helper for rate limiting
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Fetch price history for a single coin
async function fetchCoinPriceHistory(
  coinId: string,
  days: number,
  vs_currency: string = 'usd'
): Promise<PriceHistoryData> {
  const response = await fetch(
    `${COINGECKO_API}/coins/${coinId}/market_chart?vs_currency=${vs_currency}&days=${days}`
  )

  if (!response.ok) {
    throw new Error(`Failed to fetch price history for ${coinId}: ${response.statusText}`)
  }

  return response.json()
}

// Fetch price history from CDP contract
async function fetchPriceHistoryFromCDP(
  denoms: string[],
  days: number,
  rpcUrl: string
): Promise<PriceHistoryByAsset> {
  const result: PriceHistoryByAsset = {}
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
  const cutoffTimestamp = Math.floor(Date.now() / 1000) - (days * 24 * 60 * 60) // seconds

  // Fetch price history for each denom
  for (const denom of denoms) {
    try {
      const response = await getHistoricalOraclePrices(denom, cosmWasmClient)
      
      if (!response?.prices || response.prices.length === 0) {
        continue
      }

      // Transform CDP response to CoinGecko format
      // CDP: { price: string, timestamp: u64 (seconds) }[]
      // CoinGecko: [timestamp (ms), price (number)][]
      const prices: [number, number][] = response.prices
        .filter(pt => pt.timestamp >= cutoffTimestamp) // Filter by time range
        .map(pt => [
          pt.timestamp * 1000, // Convert seconds to milliseconds
          parseFloat(pt.price) // Convert string to number
        ])
        .sort((a, b) => a[0] - b[0]) // Sort by timestamp

      if (prices.length > 0) {
        result[denom] = {
          prices,
        }
      }
    } catch (error) {
      console.error(`Error fetching CDP price history for ${denom}:`, error)
    }
  }

  return result
}

// Fetch price history for multiple denoms (CoinGecko)
async function fetchPriceHistoryForDenomsCoinGecko(
  denoms: string[],
  days: number
): Promise<PriceHistoryByAsset> {
  const result: PriceHistoryByAsset = {}

  // Get unique CoinGecko IDs from denoms
  const coinIdMap = new Map<string, string[]>() // coinId -> denoms[]

  for (const denom of denoms) {
    const coinId = DENOM_TO_COINGECKO[denom]
    if (coinId) {
      if (!coinIdMap.has(coinId)) {
        coinIdMap.set(coinId, [])
      }
      coinIdMap.get(coinId)!.push(denom)
    }
  }

  // Fetch each unique coin ID with rate limiting
  for (const [coinId, relatedDenoms] of coinIdMap) {
    try {
      const priceData = await fetchCoinPriceHistory(coinId, days)

      // Map the same price data to all denoms that use this coin
      for (const denom of relatedDenoms) {
        result[denom] = priceData
      }

      // Rate limiting: wait 200ms between requests (CoinGecko free tier: 10-50 calls/min)
      await delay(200)
    } catch (error) {
      console.error(`Error fetching price history for ${coinId}:`, error)
    }
  }

  return result
}

// Main function that routes to either CDP or CoinGecko based on toggle
async function fetchPriceHistoryForDenoms(
  denoms: string[],
  days: number,
  rpcUrl?: string
): Promise<PriceHistoryByAsset> {
  if (USE_CDP_HISTORICAL_PRICES) {
    if (!rpcUrl) {
      console.error('rpcUrl is required when using CDP historical prices')
      return {}
    }
    return fetchPriceHistoryFromCDP(denoms, days, rpcUrl)
  } else {
    return fetchPriceHistoryForDenomsCoinGecko(denoms, days)
  }
}

// Get aligned timestamps from price history data
export function getAlignedTimestamps(priceHistory: PriceHistoryByAsset): number[] {
  const allTimestamps = new Set<number>()

  for (const data of Object.values(priceHistory)) {
    if (data?.prices) {
      for (const [timestamp] of data.prices) {
        allTimestamps.add(timestamp)
      }
    }
  }

  return Array.from(allTimestamps).sort((a, b) => a - b)
}

// Get price at specific index for a denom
export function getPriceAtIndex(
  priceHistory: PriceHistoryByAsset,
  denom: string,
  index: number
): number {
  const data = priceHistory[denom]
  if (!data?.prices || index >= data.prices.length) {
    return 0
  }
  return data.prices[index][1]
}

// Interpolate price at a specific timestamp
export function getPriceAtTimestamp(
  priceHistory: PriceHistoryByAsset,
  denom: string,
  timestamp: number
): number {
  const data = priceHistory[denom]
  if (!data?.prices || data.prices.length === 0) {
    return 0
  }

  // Find the closest price point
  const prices = data.prices
  for (let i = 0; i < prices.length; i++) {
    if (prices[i][0] >= timestamp) {
      // If exact match or first point, return this price
      if (i === 0 || prices[i][0] === timestamp) {
        return prices[i][1]
      }
      // Interpolate between previous and current
      const [prevTs, prevPrice] = prices[i - 1]
      const [currTs, currPrice] = prices[i]
      const ratio = (timestamp - prevTs) / (currTs - prevTs)
      return prevPrice + (currPrice - prevPrice) * ratio
    }
  }

  // Return last price if timestamp is after all data
  return prices[prices.length - 1][1]
}

/**
 * Hook to fetch historical price data from CoinGecko or CDP contract
 *
 * @param denoms Array of asset denoms to fetch prices for
 * @param days Number of days of history (7, 30, 90, 180)
 * @param rpcUrl RPC URL for CDP contract queries (required when USE_CDP_HISTORICAL_PRICES is true)
 * @returns React Query result with price history by denom
 */
export function usePriceHistory(denoms: string[], days: TimeRange = 30, rpcUrl?: string) {
  return useQuery({
    queryKey: ['price_history', denoms.sort().join(','), days, USE_CDP_HISTORICAL_PRICES ? rpcUrl : 'coingecko'],
    queryFn: () => fetchPriceHistoryForDenoms(denoms, days, rpcUrl),
    staleTime: 1000 * 60 * 5, // 5 minute cache
    gcTime: 1000 * 60 * 30, // Keep in cache for 30 minutes
    enabled: denoms.length > 0 && (!USE_CDP_HISTORICAL_PRICES || !!rpcUrl),
    retry: 2,
    retryDelay: 1000,
  })
}

export default usePriceHistory
