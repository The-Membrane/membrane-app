import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getRewardHistory } from '@/services/acquisition'
import type { RewardHistoryResponse } from '@/services/acquisition'

/**
 * Hook to fetch a user's acquisition reward history.
 *
 * Queries the acquisition contract with { get_reward_history: { user } }.
 * Uses a 2-minute staleTime (volatile tier) since rewards can accrue
 * between claims.
 *
 * @param user - The user's wallet address, or undefined if not connected
 * @returns React Query result containing RewardHistoryResponse | null
 */
export const useAcquisitionRewardHistory = (user: string | undefined) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery<RewardHistoryResponse | null>({
        queryKey: ['acquisition', 'reward-history', user, appState.rpcUrl],
        queryFn: () => getRewardHistory(client || null, user || ''),
        enabled: !!user,
        staleTime: 1000 * 60 * 2, // 2 minutes - volatile tier
    })
}
