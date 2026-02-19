import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getIntentBoosts } from '@/services/systemDiscounts'
import type { MbrnIntentOption } from '@/types/lockdropIntents'

/**
 * Hook to query intent boosts from system_discounts contract
 */
export const useIntentBoosts = (intents: MbrnIntentOption[]) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['intent_boosts', appState.rpcUrl, JSON.stringify(intents)],
        queryFn: () => getIntentBoosts(client || null, intents),
        enabled: intents.length > 0 && !!client,
        staleTime: 30000, // Cache for 30 seconds
    })
}





















