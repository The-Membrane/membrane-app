import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useRacingState from './useRacingState'
import type { EvmCall } from '@/services/chain/types'

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
    numberOfRaces?: number
    maxRaceTicks?: number
}

/**
 * TODO(evm-migration): the Racing mini-game raceEngine (Q-learning race sim)
 * contract has NO equivalent in the Solidity port. This CTA hook returns no msgs so
 * the "run race" action stays inert until/if racing contracts are ported.
 * Return shape preserved for consumers.
 */
const useRunRace = (params: UseRunRaceParams) => {
    const { address } = useWallet()
    const { appState } = useAppState()
    const { racingState, setRacingState, incrementSingularityTrainingSessions } = useRacingState()

    const { data: msgs } = useQuery<EvmCall[] | undefined>({
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
            params.numberOfRaces ?? null,
            params.maxRaceTicks ?? null,
            racingState.rewardConfig ?? null,
        ],
        queryFn: () => [] as EvmCall[],
        enabled: !!address,
    })

    const onInitialSuccess = () => {
        if (params.train) {
            const totalEnergyConsumed = ENERGY_CONSUMED_PER_TRAINING_SESSION * (params.numberOfRaces ?? 1)
            setRacingState({ energy: racingState.energy - totalEnergyConsumed, energyColor: '#ff0000' })

            setTimeout(() => {
                setRacingState({ energyColor: '#7cffa0' })
            }, 1000)
        }

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

                // Invalidate brain progress for each car after training races
                if (params.train) {
                    queryClient.invalidateQueries({
                        queryKey: ['car_brain_progress', contracts.raceEngine, carId],
                        refetchType: 'active' // Force refetch of active queries
                    })
                }

                // queryClient.invalidateQueries({ queryKey: ['car_metadata', contracts.car, carId] })
                // queryClient.invalidateQueries({ queryKey: ['car_energy', contracts.car, carId] })

                // OPTIMIZATION: track_training_stats is invalidated globally above, so no need to invalidate per-car
                // This prevents duplicate invalidations and multiple refetches of the same data
            })
        }

        // Invalidate track-specific queries
        if (params.trackId) {
            // Invalidate top_times for this track
            queryClient.invalidateQueries({
                queryKey: ['top_times', contracts.raceEngine, params.trackId],
                refetchType: 'active' // Force refetch of active queries
            })
        }

        // Increment training sessions count for The Singularity when PvP races complete
        if (params.pvp) {
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

    // Build a stable signature so simulation reruns when message CONTENT changes (not just count)
    const simulationSignature = [
        params.trackId ?? 'none',
        (params.carIds ?? []).join(','),
        String(params.train ?? false),
        String(params.pvp ?? false),
        String(params.advanced ?? false),
        String(params.explorationRate ?? 0),
        String(params.enableDecay ?? false),
        String(params.numberOfRaces ?? 1),
        String(params.maxRaceTicks ?? 'undef'),
    ].join('|')

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['run_race_sim', simulationSignature],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
            shrinkMessage: true,
        }),
    }
}

export default useRunRace 