import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import type { EvmCall } from '@/services/chain/types'

export type TrainingPaymentOption = {
    denom: string
    amount: string
}

/**
 * TODO(evm-migration): the Racing mini-game tournament contract has NO equivalent in
 * the Solidity port. These CTA hooks return no msgs so tournament actions (register,
 * run next match, start tournament) stay inert until/if racing contracts are ported.
 * Return shapes preserved for consumers.
 */

// Hook for registering for tournament
export const useRegisterForTournament = (params: {
    carId?: number | null
    paymentOption?: TrainingPaymentOption | null
    isRegistered?: boolean
    onSuccess?: () => void
}) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    const { data: msgs } = useQuery<EvmCall[] | undefined>({
        queryKey: [
            'register_tournament_msgs',
            address ?? null,
            appState.rpcUrl,
            params.carId ?? null,
            params.paymentOption?.denom ?? null,
            params.paymentOption?.amount ?? null,
            params.isRegistered ?? null,
        ],
        queryFn: () => [] as EvmCall[],
        enabled: !!address && params.carId != null,
    })

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

    const { data: msgs } = useQuery<EvmCall[] | undefined>({
        queryKey: [
            'run_next_match_msgs',
            address ?? null,
            appState.rpcUrl,
        ],
        queryFn: () => [] as EvmCall[],
        enabled: !!address,
    })

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

    const { data: msgs } = useQuery<EvmCall[] | undefined>({
        queryKey: [
            'start_tournament_msgs',
            address ?? null,
            appState.rpcUrl,
            params.trackId,
            params.maxParticipants ?? null,
        ],
        queryFn: () => [] as EvmCall[],
        enabled: !!address,
    })

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
