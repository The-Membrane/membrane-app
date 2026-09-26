import { useQuery, useQueries } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import {
    getAssetQueue,
    getAllUserDeposits,
    getUnstakeRequests,
    getUserLifetimeRevenue,
    getPendingClaims,
    getDailyTVL,
    getDailyDeposits,
    getRevenueEvents,
    getSlotWeights,
    getAssets,
    getTotalInsurance,
    getUserTotalDeposits,
    getManagerPerformance,
    getEffectiveUnlockTime,
} from '@/services/disco'

/**
 * Get all assets that have queues
 */
export const useDiscoAssets = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'assets', appState.rpcUrl],
        queryFn: () => getAssets(client || null),
        enabled: true, // Always enabled for mock data
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get asset queue (LTV-designated slots) for an asset
 */
export const useDiscoSlots = (asset: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'asset_queue', asset, appState.rpcUrl],
        queryFn: () => getAssetQueue(client || null, asset),
        enabled: true, // Always enabled for mock data
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get all user deposits across all assets (single query)
 */
export const useAllUserDeposits = (user: string | undefined) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'all_user_deposits', user, appState.rpcUrl],
        queryFn: () => getAllUserDeposits(client || null, user || ''),
        enabled: !!user, // Enable even without client for mock data
        staleTime: 1000 * 60 * 2,
    })
}

/**
 * Get all user deposits, returned as an array of query results
 * for backwards compatibility with consumers expecting useQueries format.
 */
export const useAllUserDiscoDeposits = (user: string | undefined) => {
    const query = useAllUserDeposits(user)
    return [query]
}

/**
 * Get pending unstake requests for a user and asset
 */
export const useUnstakeRequests = (user: string | undefined, asset: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'unstake_requests', user, asset, appState.rpcUrl],
        queryFn: () => getUnstakeRequests(client || null, user || '', asset),
        enabled: !!user && !!asset,
        staleTime: 1000 * 60 * 1,
    })
}

/**
 * Get effective unlock time for an unstake request, accounting for liquidation lockout
 */
export const useEffectiveUnlockTime = (
    user: string | undefined,
    asset: string,
    slot: number,
    depositId: string,
) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'effective_unlock_time', user, asset, slot, depositId, appState.rpcUrl],
        queryFn: () => getEffectiveUnlockTime(client || null, asset, slot, depositId, user || ''),
        enabled: !!user && !!asset && !!depositId,
        staleTime: 1000 * 60 * 1,
    })
}

/**
 * Get user's lifetime revenue for an asset
 */
export const useUserLifetimeRevenue = (user: string | undefined, asset: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'lifetime_revenue', user, asset, appState.rpcUrl],
        queryFn: () => getUserLifetimeRevenue(client || null, user || '', asset),
        enabled: !!user && !!asset,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get pending claims for user and asset
 */
export const usePendingClaims = (user: string | undefined, asset: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'pending_claims', user, asset, appState.rpcUrl],
        queryFn: () => getPendingClaims(client || null, user || '', asset),
        enabled: !!user && !!asset,
        staleTime: 1000 * 60 * 1,
    })
}

/**
 * Get daily TVL history
 */
export const useDailyTVL = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'daily_tvl', appState.rpcUrl],
        queryFn: () => getDailyTVL(client || null),
        enabled: !!client,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get daily deposit history for an asset
 */
export const useDailyDeposits = (asset: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'daily_deposits', asset, appState.rpcUrl],
        queryFn: () => getDailyDeposits(client || null, asset),
        enabled: !!client && !!asset,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get revenue events for a specific slot
 */
export const useRevenueEvents = (asset: string, slot: number) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'revenue_events', asset, slot, appState.rpcUrl],
        queryFn: () => getRevenueEvents(client || null, asset, slot),
        enabled: !!client && !!asset && slot >= 1,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get computed revenue weights for all slots
 */
export const useSlotWeights = (asset: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'slot_weights', asset, appState.rpcUrl],
        queryFn: () => getSlotWeights(client || null, asset),
        enabled: !!asset,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get user's total deposits value
 */
export const useUserTotalDeposits = (user: string | undefined) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'user_total_deposits', user, appState.rpcUrl],
        queryFn: () => getUserTotalDeposits(client || null, user || ''),
        enabled: !!client && !!user,
        staleTime: 1000 * 60 * 2,
    })
}

/**
 * Get historic manager performance (fees, losses, capital managed)
 */
export const useManagerPerformance = (manager: string | undefined) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'manager_performance', manager, appState.rpcUrl],
        queryFn: () => getManagerPerformance(client || null, manager || ''),
        enabled: !!client && !!manager,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Aggregate user metrics across all assets
 */
export const useDiscoUserMetrics = (user: string | undefined) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { data: assets } = useDiscoAssets()
    const { data: dailyTVL } = useDailyTVL()
    const { data: totalInsurance } = useQuery({
        queryKey: ['disco', 'total_insurance', appState.rpcUrl],
        queryFn: () => getTotalInsurance(client || null),
        enabled: !!client,
        staleTime: 1000 * 60 * 5,
    })

    // Get all user deposits (single query instead of per-asset)
    const { data: allDepositsData, isLoading: depositsLoading } = useAllUserDeposits(user)
    const deposits = allDepositsData?.deposits || []

    // For mock data, ensure we have at least one asset to query
    const assetsToQuery = assets?.assets && assets.assets.length > 0
        ? assets.assets
        : ['ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4']

    // Get pending claims for all assets
    const pendingClaimsQueries = useQueries({
        queries: assetsToQuery.map((asset: string) => ({
            queryKey: ['disco', 'pending_claims', user, asset, appState.rpcUrl],
            queryFn: () => getPendingClaims(client || null, user || '', asset),
            enabled: !!user && !!asset,
            staleTime: 1000 * 60 * 1,
        }))
    })
    const pendingClaims = pendingClaimsQueries
        .map(q => q.data?.claims || [])
        .flat()

    // Get lifetime revenue for all assets
    const lifetimeRevenueQueries = useQueries({
        queries: assetsToQuery.map((asset: string) => ({
            queryKey: ['disco', 'lifetime_revenue', user, asset, appState.rpcUrl],
            queryFn: () => getUserLifetimeRevenue(client || null, user || '', asset),
            enabled: !!user && !!asset,
            staleTime: 1000 * 60 * 5,
        }))
    })
    const lifetimeRevenue = lifetimeRevenueQueries
        .map(q => q.data || [])
        .flat()

    return {
        deposits,
        pendingClaims,
        lifetimeRevenue,
        dailyTVL: dailyTVL?.entries || [],
        totalInsurance: totalInsurance || "0",
        isLoading: depositsLoading ||
            pendingClaimsQueries.some(q => q.isLoading) ||
            lifetimeRevenueQueries.some(q => q.isLoading),
    }
}
