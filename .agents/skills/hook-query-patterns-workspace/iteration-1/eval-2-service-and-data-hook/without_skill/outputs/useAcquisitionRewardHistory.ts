import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getRewardHistory } from '@/services/acquisition'
import type { RewardHistoryResponse } from '@/services/acquisition'

/**
 * Get user's acquisition reward history
 *
 * Queries the acquisition contract's get_reward_history endpoint
 * for the given user address. Returns the full react-query result
 * including data, isLoading, error, etc.
 */
export const useAcquisitionRewardHistory = (user: string | undefined) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery<RewardHistoryResponse | null>({
        queryKey: ['acquisition', 'reward-history', user, appState.rpcUrl],
        queryFn: () => getRewardHistory(client || null, user || ''),
        enabled: !!user,
        staleTime: 1000 * 60 * 5, // 5 minutes
    })
}
