import React from 'react'
import { useQuery, useQueries } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import {
    getUserDeposits,
    getPendingLocks,
    getCurrentLockdrop,
    getAllDeposits,
    getUserHistory,
    getLockdropConfig,
    getAcquisitionHistory,
    getAcquisitionModelState,
    getCurrentAcquisitionWindow,
} from '@/services/acquisition'

const LOCK_CEILING = 365

/**
 * Calculate points for a deposit
 * points = deposit * (lock_days / lock_ceiling)
 */
export const calculatePoints = (deposit: string | number, lockDays: number): number => {
    const depositNum = typeof deposit === 'string' ? parseFloat(deposit) : deposit
    return depositNum * (1 + lockDays / LOCK_CEILING)
}

/*
 * Get current lockdrop state
 */
export const useCurrentAcquisition = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['acquisition', 'current', appState.rpcUrl],
        queryFn: () => getCurrentLockdrop(client || null),
        enabled: true, // Always enabled - service handles mock data when client is null
        staleTime: 1000 * 60 * 5, // 5 minutes
    })
}

/**
 * Get pending locks (list of users)
 */
export const usePendingDeposits = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    const query = useQuery({
        queryKey: ['acquisition', 'pending-locks', appState.rpcUrl],
        queryFn: () => {
            return getPendingLocks(client || null)
        },
        enabled: true, // Always enabled - service handles mock data when client is null
        staleTime: 1000 * 60 * 5,
    })


    return query
}

/**
 * Get user deposits
 */
export const useUserAcquisitionDeposits = (user: string | undefined) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['acquisition', 'user-deposits', user, appState.rpcUrl],
        queryFn: () => getUserDeposits(client || null, user || ''),
        enabled: !!user, // Enable for mock data even without client
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get all deposits with calculated points and allocations
 */
export const useAcquisition = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { data: pendingLocks, isLoading: pendingLocksLoading } = usePendingDeposits()

    // Query deposits for all users
    // Note: When using mock data, client can be null, so we enable queries if we have users
    const depositQueries = useQueries({
        queries: (pendingLocks?.users || []).map((user: string) => ({
            queryKey: ['acquisition', 'user-deposits', user, appState.rpcUrl],
            queryFn: () => {
                return getUserDeposits(client || null, user)
            },
            enabled: !!user, // Enable if we have a user (mock data works without client)
            staleTime: 1000 * 60 * 5,
        }))
    })


    // Process and calculate allocations
    const processedData = React.useMemo(() => {
        // Wait for pending locks to load
        if (!pendingLocks?.users) {
            return {
                deposits: [],
                totalPoints: 0,
                allocations: [],
                groupedByLockDays: {},
            }
        }

        // If no users, return empty
        if (pendingLocks.users.length === 0) {
            return {
                deposits: [],
                totalPoints: 0,
                allocations: [],
                groupedByLockDays: {},
            }
        }

        // Aggregate all deposits with user info
        const allDeposits: Array<{
            user: string
            amount: string
            lockDays: number
            points: number
        }> = []

        depositQueries.forEach((query, index) => {
            // Make sure we have a valid user for this index
            if (index >= pendingLocks.users.length) return

            const user = pendingLocks.users[index]
            // Check if query has data and deposits array
            const queryData = query.data as { deposits?: any[] } | null | undefined
            if (queryData?.deposits && Array.isArray(queryData.deposits) && queryData.deposits.length > 0) {
                queryData.deposits.forEach((deposit: any) => {
                    const amount = deposit.amount || '0'
                    const lockDays = deposit.intended_lock_days || 0

                    // Only process if we have valid data
                    if (amount && lockDays > 0) {
                        const points = calculatePoints(amount, lockDays)

                        allDeposits.push({
                            user,
                            amount,
                            lockDays,
                            points,
                        })
                    }
                })
            }
        })

        // Calculate total points
        const totalPoints = allDeposits.reduce((sum, d) => sum + d.points, 0)

        // Calculate allocations
        const allocations = allDeposits.map(deposit => ({
            ...deposit,
            allocation: totalPoints > 0 ? deposit.points / totalPoints : 0,
        }))

        // Group by lock days
        const groupedByLockDays: Record<number, typeof allocations> = {}
        allocations.forEach(allocation => {
            const lockDays = allocation.lockDays
            if (!groupedByLockDays[lockDays]) {
                groupedByLockDays[lockDays] = []
            }
            groupedByLockDays[lockDays].push(allocation)
        })

        return {
            deposits: allDeposits,
            totalPoints,
            allocations,
            groupedByLockDays,
        }
    }, [pendingLocks, depositQueries])

    const isLoading = depositQueries.some(q => q.isLoading) || pendingLocksLoading

    return {
        ...processedData,
        isLoading,
    }
}

/**
 * Get user's lockdrop history
 */
export const useUserAcquisitionHistory = (user: string | undefined) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['acquisition', 'user-history', user, appState.rpcUrl],
        queryFn: () => getUserHistory(client || null, user || ''),
        enabled: !!user,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get lockdrop config
 */
export const useAcquisitionConfig = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['acquisition', 'config', appState.rpcUrl],
        queryFn: () => getLockdropConfig(client || null),
        enabled: true, // Always enabled for mock data
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get acquisition history entries (control system snapshots over time)
 */
export const useAcquisitionHistory = (windowId?: number) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['acquisition', 'history', windowId, appState.rpcUrl],
        queryFn: () => getAcquisitionHistory(client || null, windowId),
        enabled: true,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get live acquisition model state
 */
export const useAcquisitionModelState = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['acquisition', 'model-state', appState.rpcUrl],
        queryFn: () => getAcquisitionModelState(client || null),
        enabled: true,
        staleTime: 1000 * 60 * 5,
    })
}

/**
 * Get current acquisition window details
 */
export const useCurrentAcquisitionWindow = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['acquisition', 'current-window', appState.rpcUrl],
        queryFn: () => getCurrentAcquisitionWindow(client || null),
        enabled: true,
        staleTime: 1000 * 60 * 5,
    })
}

