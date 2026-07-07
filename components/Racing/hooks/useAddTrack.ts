import contracts from '@/config/contracts.json'
import useSimulateAndBroadcast from '@/hooks/useSimulateAndBroadcast'
import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { useQuery } from '@tanstack/react-query'
import { queryClient } from '@/pages/_app'
import type { EvmCall } from '@/services/chain/types'

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

/**
 * TODO(evm-migration): the Racing mini-game (Q-learning racer / trackManager,
 * raceEngine, byteMinter, car NFT, tournament contracts) has NO equivalent in the
 * Solidity port. This CTA hook returns no msgs so the "add track" action stays inert
 * until/if racing contracts are ported. Return shape preserved for consumers.
 */
const useAddTrack = (params: UseAddTrackParams) => {
  const { address } = useWallet()
  const { appState } = useAppState()

  const { data: msgs } = useQuery<EvmCall[] | undefined>({
    queryKey: [
      'add_track_msgs_creation',
      address,
      appState.rpcUrl,
      params
    ],
    queryFn: () => [] as EvmCall[],
    enabled: !!address,
  })

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

  // Stable signature: name, width, height and a hash-like summary of layout size
  const layoutDims = `${params.layout?.length ?? 0}x${params.layout?.[0]?.length ?? 0}`
  const simulationSignature = [
    params.name ?? '',
    String(params.width ?? ''),
    String(params.height ?? ''),
    layoutDims,
    appState.rpcUrl ?? '',
  ].join('|')

  const action = useSimulateAndBroadcast({
    msgs,
    queryKey: ['add_track_sim', simulationSignature],
    onSuccess: onInitialSuccess,
    enabled: !!msgs?.length,
  })

  console.log("useAddTrack hook - action created with onSuccess callback")

  return { action }
}

export default useAddTrack