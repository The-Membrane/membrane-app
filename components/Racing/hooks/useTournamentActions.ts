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

// Hook for registering for tournament
export const useRegisterForTournament = (params: {
    carId?: number | null
    paymentOption?: TrainingPaymentOption | null
    isRegistered?: boolean
    onSuccess?: () => void
}) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    type QueryData = { msgs: MsgExecuteContractEncodeObject[] }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'register_tournament_msgs',
            address ?? null,
            appState.rpcUrl,
            params.carId ?? null,
            params.paymentOption?.denom ?? null,
            params.paymentOption?.amount ?? null,
            params.isRegistered ?? null,
        ],
        queryFn: () => {
            if (!address || params.carId == null || params.isRegistered) return { msgs: [] }

            const msg = {
                register_for_tournament: {
                    car_id: params.carId.toString(),
                }
            }
            console.log('msg', msg)
            console.log('params.carId', params.carId)

            const funds = params.paymentOption
                ? [{ denom: params.paymentOption.denom, amount: params.paymentOption.amount }]
                : []

            const exec = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: (contracts as any).tournament as string,
                    msg: toUtf8(JSON.stringify(msg)),
                    funds,
                }),
            } as MsgExecuteContractEncodeObject

            return { msgs: [exec] }
        },
        enabled: !!address && params.carId != null,
    })

    const msgs = queryData?.msgs ?? []

    const onInitialSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['tournament'] })
        params.onSuccess?.()
    }

    const simulationSignature = [
        params.carId != null ? String(params.carId) : '',
        params.paymentOption?.denom ?? '',
        params.paymentOption?.amount ?? '',
    ].join('|')

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['register_tournament_sim', simulationSignature],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
        }),
    }
}

// Hook for running next match
export const useRunNextMatch = (params: {
    onSuccess?: () => void
}) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    type QueryData = { msgs: MsgExecuteContractEncodeObject[] }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'run_next_match_msgs',
            address ?? null,
            appState.rpcUrl,
        ],
        queryFn: () => {
            if (!address) return { msgs: [] }

            const msg = {
                run_next_match: {}
            }

            const exec = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: (contracts as any).tournament as string,
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
        queryClient.invalidateQueries({ queryKey: ['tournament'] })
        params.onSuccess?.()
    }

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['run_next_match_sim'],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
        }),
    }
}

// Hook for starting tournament (admin only)
export const useStartTournament = (params: {
    criteria: 'Random' | { TopTrained: { min_training_updates: number } } | 'AllCars'
    trackId: string
    maxParticipants?: number
    allowFreeRegistration: boolean
    registrationPaymentOptions: Array<{ denom: string; amount: string }>
    maxTicks: number
    onSuccess?: () => void
}) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    type QueryData = { msgs: MsgExecuteContractEncodeObject[] }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'start_tournament_msgs',
            address ?? null,
            appState.rpcUrl,
            params.trackId,
            params.maxParticipants ?? null,
        ],
        queryFn: () => {
            if (!address) return { msgs: [] }

            const msg = {
                start_tournament: {
                    criteria: params.criteria,
                    track_id: params.trackId,
                    max_participants: params.maxParticipants,
                    allow_free_registration: params.allowFreeRegistration,
                    registration_payment_options: params.registrationPaymentOptions,
                    max_ticks: params.maxTicks,
                }
            }

            const exec = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: (contracts as any).tournament as string,
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
        queryClient.invalidateQueries({ queryKey: ['tournament'] })
        params.onSuccess?.()
    }

    const simulationSignature = [
        params.trackId,
        params.maxParticipants?.toString() ?? '',
        params.maxTicks.toString(),
    ].join('|')

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['start_tournament_sim', simulationSignature],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
        }),
    }
}
