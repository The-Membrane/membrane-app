import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { toUtf8 } from '@cosmjs/encoding'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import useRacingState from './useRacingState'

const ENERGY_CONSUMED_PER_TRAINING_SESSION = 5

export type UseRunRaceParams = {
    trackId?: string | null
    carIds?: string[] | null
    train?: boolean
    pvp?: boolean
    advanced?: boolean
    onSuccess?: () => void
    explorationRate?: number
    enableDecay?: boolean
}

const useRunRace = (params: UseRunRaceParams) => {
    const { address } = useWallet()
    const { appState } = useAppState()
    const { racingState, setRacingState, incrementSingularityTrainingSessions } = useRacingState()

    type QueryData = { msgs: MsgExecuteContractEncodeObject[] }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'run_race_msgs_creation',
            address,
            appState.rpcUrl,
            params.trackId ?? null,
            (params.carIds ?? []).join(','),
            params.train ?? false,
            params.pvp ?? false,
            params.advanced ?? false,
            params.explorationRate ?? 0.0,
            params.enableDecay ?? false,
        ],
        queryFn: () => {
            if (!address) return { msgs: [] }
            if (!params.trackId || !params.carIds || params.carIds.length === 0) return { msgs: [] }

            const carIdsNums = params.carIds.map((id) => id)

            const msg = {
                simulate_race: {
                    track_id: params.trackId,
                    car_ids: carIdsNums,
                    train: params.train ?? false,
                    pvp: params.pvp ?? false,
                    ...(params.train && params.advanced ? {
                        training_config: {
                            training_mode: true,
                            epsilon: params.explorationRate?.toString() ?? "0.0",
                            temperature: "0.0",
                            enable_epsilon_decay: params.enableDecay ?? true,
                        }
                    } : {})
                },
            }

            // Debug logging for training config
            if (params.train) {
                console.log('Training config being sent:', {
                    train: params.train,
                    explorationRate: params.explorationRate,
                    enableDecay: params.enableDecay,
                    finalConfig: msg.simulate_race.training_config
                });
            }

            const exec = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: contracts.raceEngine,
                    msg: toUtf8(JSON.stringify(msg)),
                    funds: [],
                }),
            } as MsgExecuteContractEncodeObject

            //Add a secondary run that will use no randomness to track the car's new best time.
            //NOT USING THIS NOW BC RACES ARE EXPENSIVE.
            const exec2 = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: contracts.raceEngine,
                    msg: toUtf8(JSON.stringify({
                        simulate_race: {
                            track_id: params.trackId,
                            car_ids: carIdsNums,
                            train: false,
                            pvp: params.pvp ?? false,
                        },
                    })),
                }),
            } as MsgExecuteContractEncodeObject

            return { msgs: [exec] }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []

    const onInitialSuccess = () => {
        setRacingState({ energy: racingState.energy - ENERGY_CONSUMED_PER_TRAINING_SESSION, energyColor: '#ff0000' })

        setTimeout(() => {
            setRacingState({ energyColor: '#7cffa0' })
        }, 1000)

        // ============================================================================
        // OPTIMIZED INVALIDATION STRATEGY: Prevent duplicate refetches and over-querying
        // ============================================================================
        // 1. Use broad, non-overlapping query keys to avoid duplicate invalidations
        // 2. Each data type is invalidated exactly once per race completion
        // 3. All active queries are forced to refetch with refetchType: 'active'
        // ============================================================================

        // Invalidate all race-related queries to refresh the UI
        // Use a single invalidation for all q-racing queries to prevent duplicate refetches
        queryClient.invalidateQueries({
            queryKey: ['q-racing'],
            refetchType: 'active' // Force refetch of active queries
        })

        // Invalidate car-specific queries that might be affected by racing
        if (params.carIds) {
            params.carIds.forEach(carId => {
                queryClient.invalidateQueries({
                    queryKey: ['car_q_table', contracts.raceEngine, carId],
                    refetchType: 'active' // Force refetch of active queries
                })
                // queryClient.invalidateQueries({ queryKey: ['car_metadata', contracts.car, carId] })
                // queryClient.invalidateQueries({ queryKey: ['car_energy', contracts.car, carId] })

                // OPTIMIZATION: track_training_stats is invalidated globally above, so no need to invalidate per-car
                // This prevents duplicate invalidations and multiple refetches of the same data
            })
        }

        // Invalidate track-specific queries
        console.log("invalidating track-specific queries", params.trackId)
        if (params.trackId) {
            // Invalidate top_times for this track
            queryClient.invalidateQueries({
                queryKey: ['top_times', contracts.raceEngine, params.trackId],
                refetchType: 'active' // Force refetch of active queries
            })
        }

        // Increment training sessions count for The Singularity when PvP races complete
        if (params.pvp) {
            console.log("PvP race completed - incrementing training sessions for The Singularity (car_id 0)")
            incrementSingularityTrainingSessions()
        }

        // Invalidate list tracks query as race results might affect track statistics
        queryClient.invalidateQueries({
            queryKey: ['list_tracks', contracts.trackManager],
            refetchType: 'active' // Force refetch of active queries
        })

        // Call the onSuccess callback if provided
        if (params.onSuccess) {
            params.onSuccess();
        }
    }

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['run_race_sim', msgs?.toString() ?? '0'],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
            shrinkMessage: true,
        }),
    }
}

export default useRunRace 