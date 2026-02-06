import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import useWallet from '@/hooks/useWallet'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useCDPClient } from '@/services/cdp'
import {
    getTransmuterUSDCBalance,
    findUSDCLoopingPosition,
    calculateFunnelFillRatio,
    calculateAPRMetrics,
    getMarsVaultAPR,
    getMarsVaultCost,
    getDeploymentSnapshot,
    getUserPositions,
    getMarketConditions,
    transformToChartData,
    ChartDataPoint
} from '@/services/manic'

// MOCK DATA TOGGLE: Set to false in production
const ENABLE_MOCK_PROFIT_DATA = true

/**
 * Hook to fetch transmuter USDC balance
 */
export const useTransmuterBalance = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['transmuter_usdc_balance', client, appState.rpcUrl],
        queryFn: async () => {
            return getTransmuterUSDCBalance(client || null)
        },
        staleTime: 1000 * 30, // 30 seconds
        enabled: true // Always enabled for mock data
    })
}

/**
 * Hook to fetch user's USDC looping position
 */
export const useUSDCLoopingPosition = () => {
    const { appState } = useAppState()
    const { chainName } = useChainRoute()
    const { address } = useWallet()
    const { data: cdpClient } = useCDPClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['usdc_looping_position', address, cdpClient, appState.rpcUrl],
        queryFn: async () => {
            if (!address || !cdpClient) return null

            const basketPositions = await cdpClient.getBasketPositions({
                user: address
            })

            // getBasketPositions returns an array, get the first one
            const position = Array.isArray(basketPositions) ? basketPositions[0] : basketPositions
            return findUSDCLoopingPosition(position)
        },
        staleTime: 1000 * 30, // 30 seconds
        enabled: !!address && !!cdpClient
    })
}

/**
 * Hook to fetch Mars USDC vault APR
 */
export const useMarsVaultAPR = () => {
    const { appState } = useAppState()
    const { chainName } = useChainRoute()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['mars_vault_apr', client, chainName, appState.rpcUrl],
        queryFn: async () => {
            if (!client) return null
            return getMarsVaultAPR(client, undefined, chainName)
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        enabled: !!client
    })
}

/**
 * Hook to fetch Mars USDC vault cost
 */
export const useMarsVaultCost = () => {
    const { appState } = useAppState()
    const { chainName } = useChainRoute()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['mars_vault_cost', client, chainName, appState.rpcUrl],
        queryFn: async () => {
            if (!client) return null
            return getMarsVaultCost(client, undefined, chainName)
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        enabled: !!client
    })
}

/**
 * Hook to fetch deployment snapshot
 */
export const useDeploymentSnapshot = () => {
    const { appState } = useAppState()
    const { chainName } = useChainRoute()
    const { address } = useWallet()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['deployment_snapshot', address, client, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !address) return null
            return getDeploymentSnapshot(client, address)
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        enabled: !!client && !!address
    })
}

/**
 * Hook to fetch user positions from yield-arb
 */
export const useUserPositions = (limit: number = 100) => {
    const { appState } = useAppState()
    const { chainName } = useChainRoute()
    const { address } = useWallet()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['user_positions', address, limit, client, appState.rpcUrl],
        queryFn: async () => {
            if (!client || !address) return null
            return getUserPositions(client, address, limit)
        },
        staleTime: 1000 * 30, // 30 seconds
        enabled: !!client && !!address
    })
}

/**
 * Hook to fetch market conditions (historical APR)
 */
export const useMarketConditions = (limit: number = 100) => {
    const { appState } = useAppState()
    const { chainName } = useChainRoute()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    // Include mock data flag in query key to ensure cache invalidation
    const USE_MOCK_DATA_TRANSMUTER = true // Should match services/manic.ts

    const query = useQuery({
        queryKey: ['market_conditions', limit, client, appState.rpcUrl, USE_MOCK_DATA_TRANSMUTER],
        queryFn: async () => {
            console.log('[useMarketConditions] Query function called')
            // Remove client check - let getMarketConditions handle mock data
            const result = await getMarketConditions(client || null, limit)
            console.log('[useMarketConditions] Query result:', result?.length || 0, 'entries', result)
            if (!result || result.length === 0) {
                console.warn('[useMarketConditions] Warning: Received null or empty result')
            }
            return result
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        enabled: true, // Enable for mock data
        retry: false, // Don't retry on error for mock data
        gcTime: 0, // Don't cache - always refetch (for debugging)
    })

    console.log('[useMarketConditions] Query state:', {
        isLoading: query.isLoading,
        isError: query.isError,
        error: query.error,
        dataLength: query.data?.length || 0,
        data: query.data,
    })

    return query
}

/**
 * Generate mock profit chart data
 * TODO: Remove this mock data when real data is available
 */
const generateMockProfitData = (): ChartDataPoint[] => {
    const now = Math.floor(Date.now() / 1000)
    const daysAgo = 30 // 30 days of data
    const dataPoints: ChartDataPoint[] = []

    // Start with initial position value
    const initialValue = 10000 // 10,000 USDC initial
    let currentProfit = 0

    // Mock base APR that varies slightly over time
    const baseAPR = 4.0
    let currentAPR = baseAPR

    for (let i = daysAgo; i >= 0; i--) {
        const timestamp = now - (i * 24 * 60 * 60) // Days ago in seconds
        // Simulate gradual profit growth with some variance
        const dailyGrowth = 15 + Math.random() * 10 // $15-25 per day
        currentProfit += dailyGrowth

        // Simulate APR variation (slight changes over time)
        currentAPR = baseAPR + (Math.random() - 0.5) * 0.5 // ±0.25% variation

        // Simulate collateral and debt growth
        const collateralValue = initialValue + currentProfit * 0.6
        const debt = initialValue * 0.5 + currentProfit * 0.3
        const amountLooped = initialValue * 0.5 + currentProfit * 0.4

        dataPoints.push({
            timestamp,
            profit: currentProfit,
            collateralValue,
            debt,
            amountLooped,
            apr: currentAPR // Include historical APR
        })
    }

    return dataPoints
}

/**
 * Hook to fetch and calculate deployment profit data for chart
 */
export const useDeploymentProfitData = () => {
    const { data: snapshot, isLoading: isLoadingSnapshot } = useDeploymentSnapshot()
    const { data: positions, isLoading: isLoadingPositions } = useUserPositions(100)
    const { data: marketConditions } = useMarketConditions(100)
    const { hasPosition } = useManicData()

    return useQuery({
        queryKey: ['deployment_profit_data', snapshot, positions, marketConditions, hasPosition, ENABLE_MOCK_PROFIT_DATA],
        queryFn: () => {
            // If user has a real position, only use real data
            if (hasPosition) {
                // If we have real snapshot and positions data, use it
                if (snapshot && positions && positions.length > 0) {
                    // For now, use simple price mapping (1:1 for USDC)
                    // In a real implementation, you'd fetch historical prices
                    const prices: Record<string, number> = {}
                    const chartData = transformToChartData(positions, snapshot, prices, marketConditions || undefined)
                    if (chartData.length > 0) {
                        return chartData
                    }
                }
                // If user has position but no data yet, return empty (will show empty state)
                return []
            }

            // MOCK DATA: Only show mock data when there is NO position
            // Toggle this off in production by setting ENABLE_MOCK_PROFIT_DATA to false
            if (ENABLE_MOCK_PROFIT_DATA) {
                const mockData = generateMockProfitData()
                console.log('Using mock profit data:', mockData.length, 'data points')
                return mockData
            }
            return []
        },
        staleTime: 1000 * 30, // 30 seconds
        enabled: true // Always enabled so mock data can show
    })
}

/**
 * Main hook that combines all manic data
 */
export const useManicData = () => {
    const { data: transmuterBalance, isLoading: isLoadingBalance } = useTransmuterBalance()
    const { data: usdcPosition, isLoading: isLoadingPosition } = useUSDCLoopingPosition()
    const { data: marsAPR, isLoading: isLoadingAPR } = useMarsVaultAPR()
    const { data: marsCost } = useMarsVaultCost()
    const { data: snapshot } = useDeploymentSnapshot()

    // MOCK DATA: Create mock position if no real position exists
    // TODO: Remove this mock data when real data is available
    const mockPosition = !usdcPosition ? {
        positionId: 1,
        collateralAmount: 10000, // Mock: 10,000 USDC collateral
        debtAmount: 5000, // Mock: 5,000 USDC debt
        collateral: null
    } : null

    // Use mock position if real position doesn't exist
    const positionToUse = usdcPosition || mockPosition

    // Calculate funnel fill ratio (user's progress towards max boost)
    let funnelFillRatio = calculateFunnelFillRatio(
        positionToUse?.collateralAmount,
        positionToUse?.debtAmount
    )

    // MOCK DATA: Use mock fill ratio if real data is not available
    // TODO: Remove this mock data when real data is available
    if (funnelFillRatio === 0 && !usdcPosition) {
        funnelFillRatio = 0.65 // Mock fill ratio: 65%
    }

    // Parse base APR from Mars vault response, use mock data if not available
    const rawBaseAPR = marsAPR?.a_p_r
        ? parseFloat(marsAPR.a_p_r) * 100
        : 4.5 // Mock base APR: 4.5%

    // Parse cost from Mars vault response, use mock data if not available
    // Cost is returned as a Decimal string, parse it
    let cost = 0.5 // Default mock cost: 0.5%
    if (marsCost !== null && marsCost !== undefined) {
        const costValue = typeof marsCost === 'string' ? marsCost : String(marsCost)
        cost = parseFloat(costValue) * 100
    }

    // Subtract cost from APR to get net APR
    const baseAPR = Math.max(0, rawBaseAPR - cost)

    // Calculate APR metrics
    let aprMetrics = calculateAPRMetrics(
        baseAPR,
        positionToUse?.collateralAmount,
        positionToUse?.debtAmount
    )

    // MOCK DATA: Use mock APR metrics if real data is not available
    // TODO: Remove this mock data when real data is available
    if (!usdcPosition) {
        aprMetrics = {
            baseAPR: 4.0, // Mock base APR: 4.0%
            userAPR: 8.5, // Mock user APR: 8.5% (showing boost)
            boostPercent: 112.5, // Mock boost: 112.5%
            maxAPR: 40.0 // Mock max APR: 40.0% (10x base)
        }
    }

    // Base deposit (TVL) from snapshot (micro to unit), fallback to position collateral
    let baseDeposit = 0
    const snapshotAmount = snapshot?.collateral_assets?.[0]?.asset?.amount
    if (snapshotAmount) {
        baseDeposit = parseFloat(snapshotAmount) / 1_000_000
    } else if (positionToUse?.collateralAmount) {
        baseDeposit = positionToUse.collateralAmount
    }

    return {
        transmuterBalance,
        usdcPosition: positionToUse, // Return mock position if no real position
        funnelFillRatio,
        aprMetrics,
        isLoading: false, // Don't block rendering - show empty states instead
        hasPosition: !!usdcPosition, // Only true if real position exists (not mock)
        baseDeposit,
    }
}

