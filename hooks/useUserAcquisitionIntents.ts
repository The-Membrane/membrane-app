import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getUserIntents } from '@/services/acquisition'
import useWallet from '@/hooks/useWallet'

/**
 * Hook to query user's stored ongoing intents from acquisition contract
 * @param overrideAddress Optional address to use instead of connected wallet (for mock testing)
 */
export const useUserAcquisitionIntents = (overrideAddress?: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { address } = useWallet()
    const queryAddr = overrideAddress || address

    return useQuery({
        queryKey: ['user_acquisition_intents', queryAddr, appState.rpcUrl],
        queryFn: () => getUserIntents(client || null, queryAddr || ''),
        enabled: !!queryAddr,
        staleTime: 60000, // Cache for 1 minute
    })
}





















