import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { useQuery } from '@tanstack/react-query'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { toUtf8 } from '@cosmjs/encoding'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useAppState from '@/persisted-state/useAppState'
import { queryClient } from '@/pages/_app'

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

const usePlaySeries = (params: UsePlaySeriesParams) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    type QueryData = { msgs: MsgExecuteContractEncodeObject[] }
    const { data: queryData } = useQuery<QueryData>({
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
        queryFn: () => {
            console.log('params', params)
            if (!address) return { msgs: [] }
            if (!params.carId) return { msgs: [] }

            const carId = params.carId
            const opponentId = params.opponentId ?? '0'

            const modeMsg = params.mode?.type === 'bestOf'
                ? { best_of: { wins_target: (params.mode as SeriesModeBestOf).winsTarget } }
                : { fixed_ticks: { ticks: params.mode?.ticks ?? 10 } }

            const trainingConfig = params.train ? {
                training_mode: true,
                epsilon: params.epsilon ?? '0.6',
                temperature: params.temperature ?? '0.0',
                enable_epsilon_decay: params.enableDecay ?? true,
            } : undefined

            const msg = {
                play_series: {
                    car_id: carId,
                    opponent_id: opponentId === '0' ? null : opponentId,
                    train: params.train ?? false,
                    training_config: trainingConfig,
                    reward_config: undefined,
                    mode: modeMsg,

                }
            }

            const exec = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: (contracts as any).rpsEngine,
                    msg: toUtf8(JSON.stringify(msg)),
                    funds: [],
                }),
            } as MsgExecuteContractEncodeObject

            const count = Math.max(1, params.numberOfMatches ?? 1)
            const msgs = Array.from({ length: count }, () => ({ ...exec }))
            return { msgs }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    console.log('rps msgs', msgs)

    const onInitialSuccess = () => {
        queryClient.invalidateQueries({ queryKey: ['rps_tick_history'] })
        queryClient.invalidateQueries({ queryKey: ['rps_history'] })
    }

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


