import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useAppState from '@/persisted-state/useAppState'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

export type SeriesModeFixed = { type: 'fixed'; ticks: number }
export type SeriesModeBestOf = { type: 'bestOf'; winsTarget: number }
export type SeriesModeUi = SeriesModeFixed | SeriesModeBestOf

export type UsePlaySeriesParams = {
    carId?: string | null
    opponentId?: string | null // if undefined, default to "The Singularity" (0)
    train?: boolean
    numberOfMatches?: number // duplicate msgs count
    mode?: SeriesModeUi
    epsilon?: string // string percent (0.0-1.0)
    temperature?: string // string
    enableDecay?: boolean,
    maxTicks?: number
}

/**
 * TODO(evm-migration): the Racing mini-game rpsEngine (Q-learning play-series)
 * contract has NO equivalent in the Solidity port. This CTA hook returns no msgs so
 * the "play series" action stays inert until/if racing contracts are ported.
 * Return shape preserved for consumers.
 */
const onInitialSuccess = () => {
    queryClient.invalidateQueries({ queryKey: ['rps_tick_history'] })
    queryClient.invalidateQueries({ queryKey: ['rps_history'] })
}

const usePlaySeries = (params: UsePlaySeriesParams) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    const { data: msgs } = useQuery<EvmCall[] | undefined>({
        queryKey: [
            'rps_play_series_msgs',
            address,
            appState.rpcUrl,
            params.carId ?? null,
            params.opponentId ?? '0',
            params.train ?? false,
            params.numberOfMatches ?? 1,
            params.epsilon ?? '0.6',
            params.temperature ?? '0.0',
            params.enableDecay ?? true,
            params.mode
        ],
        queryFn: () => [] as EvmCall[],
        enabled: !!address,
    })

    // Build a stable signature so simulation reruns when message CONTENT changes (not just count)
    const simulationSignature = [
        params.carId ?? 'none',
        params.opponentId ?? '0',
        String(params.train ?? false),
        JSON.stringify(params.mode ?? {}),
        String(params.numberOfMatches ?? 1),
    ].join('|')



    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['rps_play_series_sim', simulationSignature],
            enabled: !!msgs?.length,
            onSuccess: onInitialSuccess,
            shrinkMessage: true,
        }),
    }
}

export default usePlaySeries


