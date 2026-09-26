import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getHistoricalInterestRates, getBasket } from '@/services/cdp'
import {
  MOCK_REVENUE_DATA,
  MOCK_RATE_DATA,
  MOCK_LIQUIDATION_DATA,
} from '@/services/membraneDashboardMockData'
import type {
  RevenueDataPoint,
  InterestRateDataPoint,
  LiquidationFunnelDataPoint,
} from '@/types/membraneDashboard'

const USE_MOCK_DATA = true
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

const formatDate = (ts: number): string => {
  const d = new Date(ts * 1000)
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`
}

export const useRevenueHistory = () => {
  return useQuery<RevenueDataPoint[]>({
    queryKey: ['membrane-dashboard-revenue'],
    queryFn: async () => {
      // TODO: Replace with real revenue history when available
      return MOCK_REVENUE_DATA
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useInterestRateHistory = () => {
  const { appState } = useAppState()
  const { data: cosmWasmClient } = useCosmWasmClient(appState.rpcUrl)

  return useQuery<InterestRateDataPoint[]>({
    queryKey: ['membrane-dashboard-rates', appState.rpcUrl],
    queryFn: async () => {
      if (USE_MOCK_DATA || !cosmWasmClient) return MOCK_RATE_DATA

      // Get basket to find all collateral denoms
      const contracts = (await import('@/config/contracts.json')).default
      const basket = await cosmWasmClient.queryContractSmart(contracts.cdp, { get_basket: {} })

      // Query historical rates for each collateral asset
      const collateralDenoms: string[] = basket.collateral_types?.flatMap(
        (ct: any) => {
          const denom = ct.asset?.info?.native_token?.denom
          return denom ? [denom] : []
        }
      ) ?? []

      if (collateralDenoms.length === 0) return MOCK_RATE_DATA

      // Fetch all histories in parallel
      const histories = await Promise.all(
        collateralDenoms.map((denom: string) =>
          getHistoricalInterestRates(denom, cosmWasmClient).catch(() => ({ rates: [] }))
        )
      )

      // Build a map of timestamp -> rates across all assets
      const timestampMap = new Map<number, number[]>()
      histories.forEach((history) => {
        history.rates.forEach(({ rate, timestamp }) => {
          const rateNum = parseFloat(rate) * 100 // convert to percentage
          if (!timestampMap.has(timestamp)) {
            timestampMap.set(timestamp, [])
          }
          timestampMap.get(timestamp)!.push(rateNum)
        })
      })

      if (timestampMap.size === 0) return MOCK_RATE_DATA

      // Sort by timestamp and compute avg rate + spike height
      const sorted = Array.from(timestampMap.entries()).sort((a, b) => a[0] - b[0])

      // Compute rolling average for spike detection (7-day window)
      const WINDOW = 7
      const dataPoints: InterestRateDataPoint[] = sorted.map(([timestamp, rates], idx) => {
        const avgRate = rates.reduce((s, r) => s + r, 0) / rates.length

        // Rolling average of previous WINDOW points
        const windowStart = Math.max(0, idx - WINDOW)
        const windowSlice = sorted.slice(windowStart, idx + 1)
        const rollingAvg = windowSlice.reduce((sum, [, r]) => {
          const avg = r.reduce((s, v) => s + v, 0) / r.length
          return sum + avg
        }, 0) / windowSlice.length

        // Spike height = how far above the rolling average
        const spikeHeight = Math.max(0, avgRate - rollingAvg)

        return {
          timestamp,
          date: formatDate(timestamp),
          avgRate: parseFloat(avgRate.toFixed(2)),
          spikeHeight: parseFloat(spikeHeight.toFixed(2)),
          baseRate: 3.0, // TODO: pull from getRates().base_interest_rate
        }
      })

      return dataPoints
    },
    staleTime: 1000 * 60 * 5,
    enabled: USE_MOCK_DATA || !!cosmWasmClient,
  })
}

export const useLiquidationFunnelData = () => {
  return useQuery<LiquidationFunnelDataPoint[]>({
    queryKey: ['membrane-dashboard-liquidations'],
    queryFn: async () => {
      // TODO: Replace with real liquidation event data when indexer available
      return MOCK_LIQUIDATION_DATA
    },
    staleTime: 1000 * 60 * 5,
  })
}
