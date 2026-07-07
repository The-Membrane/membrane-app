import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'
import type { EvmCall } from '@/services/chain/types'

export type UseGenerateMazeParams = {
    onSuccess?: () => void
    setRacingState?: (state: any) => void
    validMazeId?: string | null
}

/**
 * TODO(evm-migration): the Racing mini-game byteMinter/maze contract has NO
 * equivalent in the Solidity port. This CTA hook returns no msgs so the "generate
 * maze" action stays inert until/if racing contracts are ported. Return shape preserved.
 */
const useGenerateMaze = (params: UseGenerateMazeParams) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    const { data: msgs } = useQuery<EvmCall[] | undefined>({
        queryKey: [
            'generate_maze_and_start_window_msgs_creation',
            address,
            appState.rpcUrl,
        ],
        queryFn: () => [] as EvmCall[],
        enabled: !!address,
    })
    // console.log("generate maze and start window msgs", msgs)

    const onInitialSuccess = () => {
        // Invalidate all byte-minter related queries to refresh QRacerTicker data
        queryClient.invalidateQueries({
            queryKey: ['byte_minter'],
            refetchType: 'active'
        })

        // Invalidate specific queries used by QRacerTicker
        queryClient.invalidateQueries({
            queryKey: ['byte_minter_until_open'],
            refetchType: 'active'
        })

        queryClient.invalidateQueries({
            queryKey: ['byte_minter_valid_maze_id'],
            refetchType: 'active'
        })

        queryClient.invalidateQueries({
            queryKey: ['byte_minter_window_status'],
            refetchType: 'active'
        })

        queryClient.invalidateQueries({
            queryKey: ['byte_minter_config'],
            refetchType: 'active'
        })

        // Wait a bit for the new maze to be available, then automatically trigger Solve behavior
        setTimeout(() => {
            // If we have setRacingState and no valid maze ID, the new maze should be available
            if (params.setRacingState && !params.validMazeId) {
                // Query for the new maze ID
                const fetchNewMazeId = async () => {
                    try {
                        const addr = (contracts as any).byteMinter as string | undefined;
                        if (!addr) return;

                        const client = await getCosmWasmClient(appState.rpcUrl);
                        const res = await client.queryContractSmart(addr, { valid_maze_id: {} } as any);
                        const newMazeId = res?.track_id?.toString();

                        if (newMazeId && params.setRacingState) {
                            // Automatically set the new maze track and switch to showcase mode
                            params.setRacingState({
                                selectedTrackId: newMazeId,
                                showTraining: false,
                                showPvp: false
                            });
                        }
                    } catch (e) {
                        console.error('Error fetching new maze ID after generation', e);
                    }
                };

                fetchNewMazeId();
            }
        }, 2000); // Wait 2 seconds for the transaction to be processed

        // Call the onSuccess callback if provided
        if (params.onSuccess) {
            params.onSuccess();
        }
    }

    // Stable simulation signature (no params, but include address and rpc for safety)
    const simulationSignature = [
        address ?? 'none',
        appState.rpcUrl ?? 'rpc'
    ].join('|')

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['generate_maze_and_start_window_sim', simulationSignature],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
            shrinkMessage: true,
        }),
    }
}

export default useGenerateMaze
