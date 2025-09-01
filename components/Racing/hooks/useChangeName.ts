import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { toUtf8 } from '@cosmjs/encoding'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'

export type UseChangeNameParams = {
    tokenId?: string | null
    newName?: string | null
}

const useChangeName = (params: UseChangeNameParams) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    type QueryData = { msgs: MsgExecuteContractEncodeObject[] }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'change_car_name_msgs_creation',
            address,
            appState.rpcUrl,
            params.tokenId ?? null,
            params.newName ?? null,
        ],
        queryFn: () => {
            if (!address) return { msgs: [] }
            if (!params.tokenId || !params.newName) return { msgs: [] }

            const msg = {
                update_car_name: {
                    token_id: params.tokenId,
                    new_name: params.newName,
                },
            }

            const exec = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: (contracts as any).car,
                    msg: toUtf8(JSON.stringify(msg)),
                    funds: [],
                }),
            } as MsgExecuteContractEncodeObject

            return { msgs: [exec] }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    const onInitialSuccess = () => {
        // Refresh car-related queries
        queryClient.invalidateQueries({ queryKey: ['q-racing', 'owned_cars'] })
        queryClient.invalidateQueries({ queryKey: ['car_metadata'] })
        queryClient.invalidateQueries({ queryKey: ['car_name'] })
    }

    console.log('msgs', !!msgs?.length)

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['change_car_name_sim', msgs?.toString() ?? '0'],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
        }),
    }
}

export default useChangeName 