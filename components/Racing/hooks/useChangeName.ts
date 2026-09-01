import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import type { EvmCall } from '@/services/chain/types'

export type UseChangeNameParams = {
    tokenId?: string | null
    newName?: string | null
}

/**
 * TODO(evm-migration): the Racing mini-game car NFT contract has NO equivalent in
 * the Solidity port. This CTA hook returns no msgs so the "change car name" action
 * stays inert until/if racing contracts are ported. Return shape preserved.
 */
const onInitialSuccess = () => {
    // Refresh car-related queries
    queryClient.invalidateQueries({ queryKey: ['q-racing', 'owned_cars'] })
    queryClient.invalidateQueries({ queryKey: ['car_metadata'] })
    queryClient.invalidateQueries({ queryKey: ['car_name'] })
}

const useChangeName = (params: UseChangeNameParams) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    const { data: msgs } = useQuery<EvmCall[] | undefined>({
        queryKey: [
            'change_car_name_msgs_creation',
            address,
            appState.rpcUrl,
            params.tokenId ?? null,
            params.newName ?? null,
        ],
        queryFn: () => [] as EvmCall[],
        enabled: !!address,
    })

    console.log('msgs', !!msgs?.length)

    return {
        action: useSimulateAndBroadcast({
            msgs,
            // Stable signature based on token and new name
            queryKey: ['change_car_name_sim', [params.tokenId ?? '', params.newName ?? ''].join('|')],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
        }),
    }
}

export default useChangeName 