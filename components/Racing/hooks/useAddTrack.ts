import contracts from '@/config/contracts.json'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import { MsgExecuteContractEncodeObject } from '@cosmjs/cosmwasm-stargate'
import useAppState from '@/persisted-state/useAppState'
import { useQuery } from '@tanstack/react-query'
import { toUtf8 } from '@cosmjs/encoding'
import { MsgExecuteContract } from 'cosmjs-types/cosmwasm/wasm/v1/tx'
import { queryClient } from '@/pages/_app'

export interface TileProperties {
  speed_modifier: number
  blocks_movement: boolean
  skip_next_turn: boolean
  damage: number
  is_finish: boolean
  is_start: boolean
}

export type TrackTile = TileProperties

export type UseAddTrackParams = {
  name: string
  width: number | undefined
  height: number | undefined
  layout: TrackTile[][]
  contractAddress?: string
}

const useAddTrack = (params: UseAddTrackParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()

  type QueryData = {
    msgs: MsgExecuteContractEncodeObject[]
  }
  const { data: queryData } = useQuery<QueryData>({
    queryKey: [
      'add_track_msgs_creation',
      address,
      appState.rpcUrl,
      params
    ],
    queryFn: () => {
      if (!address || !params.width || !params.height) { console.log("create trackearly return", address, params.width, params.height); return { msgs: [] } }
      var msgs = [] as MsgExecuteContractEncodeObject[]

      let addTrackMsg = {
        typeUrl: "/cosmwasm.wasm.v1.MsgExecuteContract",
        value: MsgExecuteContract.fromPartial({
          sender: address,
          contract: contracts.trackManager,
          msg: toUtf8(JSON.stringify({
            add_track: {
              name: params.name.trim(),
              width: params.width,
              height: params.height,
              layout: params.layout,
            }
          })),
          funds: []
        })
      } as MsgExecuteContractEncodeObject
      msgs.push(addTrackMsg)

      console.log("add track msgs:", msgs)

      return { msgs }
    },
    enabled: !!address,
  })

  const msgs = queryData?.msgs ?? []

  const onInitialSuccess = () => {
    console.log('Track added successfully, invalidating caches...')

    // Log current queries to debug
    const queries = queryClient.getQueryCache().getAll()
    const trackQueries = queries.filter(q => q.queryKey[0] === 'list_tracks')
    console.log('Current track queries:', trackQueries.map(q => q.queryKey))
    console.log('Expected query key:', ['list_tracks', contracts.trackManager, appState.rpcUrl])
    console.log('All queries:', queries.map(q => q.queryKey))

    // Invalidate track-related caches so UI refreshes after adding a track
    // Invalidate all list_tracks queries regardless of parameters
    queryClient.invalidateQueries({ queryKey: ['list_tracks'] })
    queryClient.invalidateQueries({ queryKey: ['q-racing', 'track'] })
    queryClient.invalidateQueries({ queryKey: ['top_times'] })
    queryClient.invalidateQueries({ queryKey: ['track_training_stats'] })

    // Force refetch of current list_tracks query if it exists
    queryClient.refetchQueries({ queryKey: ['list_tracks'] })

    // Also try to invalidate with the specific contract address and RPC URL
    // since the actual query key is ['list_tracks', contracts.trackManager, rpc]
    queryClient.invalidateQueries({
      queryKey: ['list_tracks', contracts.trackManager, appState.rpcUrl]
    })

    // Force refetch with specific parameters
    queryClient.refetchQueries({
      queryKey: ['list_tracks', contracts.trackManager, appState.rpcUrl]
    })

    // Clear all track-related caches and force refetch
    queryClient.removeQueries({ queryKey: ['list_tracks'] })
    queryClient.refetchQueries({ queryKey: ['list_tracks'] })

    // Try a different approach - force update the query data
    setTimeout(() => {
      console.log('Forcing refetch after timeout...')
      queryClient.refetchQueries({ queryKey: ['list_tracks'] })
    }, 1000)

    console.log('Cache invalidation completed')
  }

  console.log("here to return action ")

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['add_track_sim', (msgs?.toString() ?? "0")],
    onSuccess: onInitialSuccess,
    enabled: !!msgs?.length,
  })

  console.log("useAddTrack hook - action created with onSuccess callback")

  return { action }
}

export default useAddTrack