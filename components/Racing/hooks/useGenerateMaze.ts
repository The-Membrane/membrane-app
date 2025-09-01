import contracts from '@/config/contracts.json'
import useWallet from '@/hooks/useWallet'
import { queryClient } from '@/pages/_app'
import useAppState from '@/persisted-state/useAppState'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import { useQuery } from '@tanstack/react-query'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import { toUtf8 } from '@cosmjs/encoding'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'

export type UseGenerateMazeParams = {
    onSuccess?: () => void
    setRacingState?: (state: any) => void
    validMazeId?: string | null
}

const useGenerateMaze = (params: UseGenerateMazeParams) => {
    const { address } = useWallet()
    const { appState } = useAppState()

    type QueryData = { msgs: MsgExecuteContractEncodeObject[] }
    const { data: queryData } = useQuery<QueryData>({
        queryKey: [
            'generate_maze_msgs_creation',
            address,
            appState.rpcUrl,
        ],
        queryFn: () => {
            if (!address) return { msgs: [] }

            const msg = {
                generate_maze: {
                    name: `maze_${Date.now()}`
                },
            }

            const exec = {
                typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
                value: MsgExecuteContract.fromPartial({
                    sender: address,
                    contract: (contracts as any).byteMinter,
                    msg: toUtf8(JSON.stringify(msg)),
                    funds: [],
                }),
            } as MsgExecuteContractEncodeObject

            return { msgs: [exec] }
        },
        enabled: !!address,
    })

    const msgs = queryData?.msgs ?? []
    // console.log("generate maze msgs", msgs)

    const onInitialSuccess = () => {
        // Invalidate byte-minter queries to refresh maze state
        queryClient.invalidateQueries({
            queryKey: ['byte_minter'],
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

    return {
        action: useSimulateAndBroadcast({
            msgs,
            queryKey: ['generate_maze_sim', msgs?.toString() ?? '0'],
            onSuccess: onInitialSuccess,
            enabled: !!msgs?.length,
            shrinkMessage: true,
        }),
    }
}

export default useGenerateMaze
