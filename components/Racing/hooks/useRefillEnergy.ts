import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { toUtf8 } from '@cosmjs/encoding'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'

export type TrainingPaymentOption = {
    denom: string
    amount: string
}

export type UseRefillEnergyParams = {
    tokenId?: string | null
    paymentOption?: TrainingPaymentOption | null
    contractAddress?: string
}

const useRefillEnergy = (params: UseRefillEnergyParams) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    type QueryData = { msgs: MsgExecuteContractEncodeObject[] }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'refill_energy_msgs_creation',
            address ?? null,
            appState.rpcUrl,
            params.tokenId ?? null,
            params.paymentOption?.denom ?? null,
            params.paymentOption?.amount ?? null,
            params.contractAddress ?? (contracts as any).car ?? null,
        ],
        queryFn: () => {
            if (!address) return { msgs: [] }
            if (!params.tokenId) return { msgs: [] }

            const msg = {
                pay_for_training: {
                    token_id: params.tokenId,
                },
            }

            const funds = params.paymentOption
                ? [{ denom: params.paymentOption.denom, amount: params.paymentOption.amount }]
                : []

            const exec = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: (params.contractAddress ?? (contracts as any).car) as string,
                    msg: toUtf8(JSON.stringify(msg)),
                    funds,
                }),
            } as MsgExecuteContractEncodeObject

            return { msgs: [exec] }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    console.log('energy msgs', msgs)

    const onInitialSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['car_energy'] })
        queryClient.invalidateQueries({ queryKey: ['neutron balances'] })
    }
    console.log('energy msgs', msgs)
    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: [
                'refill_energy_sim',
                address ?? '',
                appState.rpcUrl,
                params.tokenId ?? '',
                params.paymentOption?.denom ?? '',
                params.paymentOption?.amount ?? '',
            ],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
        }),
    }
}

export default useRefillEnergy


