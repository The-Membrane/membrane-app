import { useQuery, useQueries } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import useWallet from '@/hooks/useWallet'
import {
    getLTVQueue,
    getUserDeposits,
    getUserLockedDeposits,
    getUserLifetimeRevenue,
    getPendingClaims,
    getDailyTVL,
    getRevenueEvents,
    getAssets,
    getTotalInsurance
} from '@/services/disco'

/**
 * Get all assets that have LTV queues
 */
export const useDiscoAssets = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'assets', appState.rpcUrl],
        queryFn: () => getAssets(client || null),
        enabled: !!client,
        staleTime: 1000 * 60 * 5, // 5 minutes
    })
}

/**
 * Get LTV queue for an asset
 */
export const useDiscoLTVQueue = (asset: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'ltv_queue', asset, appState.rpcUrl],
        queryFn: () => getLTVQueue(client || null, asset),
        enabled: !!client && !!asset,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get user's deposits for an asset
 */
export const useUserDiscoDeposits = (user: string | undefined, asset: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'user_deposits', user, asset, appState.rpcUrl],
        queryFn: () => getUserDeposits(client || null, user || '', asset),
        enabled: !!client && !!user && !!asset,
        staleTime: 1000 * 60 * 2, // 2 minutes
    })
}

/**
 * Get all user deposits across all assets
 */
export const useAllUserDiscoDeposits = (user: string | undefined) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { data: assets } = useDiscoAssets()

    return useQueries({
        queries: (assets?.assets || []).map((asset: string) => ({
            queryKey: ['disco', 'user_deposits', user, asset, appState.rpcUrl],
            queryFn: () => getUserDeposits(client || null, user || '', asset),
            enabled: !!client && !!user && !!asset,
            staleTime: 1000 * 60 * 2,
        }))
    })
}

/**
 * Get user's locked deposits
 */
export const useUserLockedDeposits = (user: string | undefined) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'locked_deposits', user, appState.rpcUrl],
        queryFn: () => getUserLockedDeposits(client || null, user || ''),
        enabled: !!client && !!user,
        staleTime: 1000 * 60 * 2,
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
        enabled: !!client && !!user && !!asset,
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
        enabled: !!client && !!user && !!asset,
        staleTime: 1000 * 60 * 1, // 1 minute
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
 * Get revenue events for a specific group
 */
export const useRevenueEvents = (asset: string, ltv: string, maxBorrowLtv: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['disco', 'revenue_events', asset, ltv, maxBorrowLtv, appState.rpcUrl],
        queryFn: () => getRevenueEvents(client || null, asset, ltv, maxBorrowLtv),
        enabled: !!client && !!asset && !!ltv && !!maxBorrowLtv,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Aggregate user metrics
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

    // Get all user deposits
    const allDepositsQueries = useAllUserDiscoDeposits(user)
    const deposits = allDepositsQueries
        .map(q => q.data?.deposits || [])
        .flat()

    // Get pending claims for all assets using useQueries
    const pendingClaimsQueries = useQueries({
        queries: (assets?.assets || []).map((asset: string) => ({
            queryKey: ['disco', 'pending_claims', user, asset, appState.rpcUrl],
            queryFn: () => getPendingClaims(client || null, user || '', asset),
            enabled: !!client && !!user && !!asset,
            staleTime: 1000 * 60 * 1,
        }))
    })
    const pendingClaims = pendingClaimsQueries
        .map(q => q.data?.claims || [])
        .flat()

    // Get lifetime revenue for all assets using useQueries
    const lifetimeRevenueQueries = useQueries({
        queries: (assets?.assets || []).map((asset: string) => ({
            queryKey: ['disco', 'lifetime_revenue', user, asset, appState.rpcUrl],
            queryFn: () => getUserLifetimeRevenue(client || null, user || '', asset),
            enabled: !!client && !!user && !!asset,
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
        isLoading: allDepositsQueries.some(q => q.isLoading) ||
            pendingClaimsQueries.some(q => q.isLoading) ||
            lifetimeRevenueQueries.some(q => q.isLoading),
    }
}

