import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getUserIntents } from '@/services/transmuterLockdrop'
import useWallet from '@/hooks/useWallet'

/**
 * Hook to query user's stored ongoing intents from transmuter-lockdrop contract
 */
export const useUserLockdropIntents = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { address } = useWallet()

    return useQuery({
        queryKey: ['user_lockdrop_intents', address, appState.rpcUrl],
        queryFn: () => getUserIntents(client || null, address || ''),
        enabled: !!address && !!client,
        staleTime: 60000, // Cache for 1 minute
    })
}




















