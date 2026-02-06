import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import useWallet from '@/hooks/useWallet'
import { getUserBoost } from '@/services/systemDiscounts'

/**
 * Hook to fetch user boost from system_discounts contract
 */
export const useUserBoost = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { address } = useWallet()

    return useQuery({
        queryKey: ['user_boost', address, appState.rpcUrl],
        queryFn: async () => {
            // Always return data (mock if needed)
            return getUserBoost(client || null, address || 'mock-user')
        },
        enabled: true, // Always enabled to show mock data
        staleTime: 1000 * 60 * 2, // 2 minutes
    })
}
