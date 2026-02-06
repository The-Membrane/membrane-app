import { useQuery } from '@tanstack/react-query'
import { getMarsLTVInfo } from '@/services/marsMirror'
import useAppState from '@/persisted-state/useAppState'

/**
 * Hook to get Mars LTV info for an asset from mars-mirror contract
 * 
 * @param marsMirrorContract - The mars-mirror contract address
 * @param asset - The asset denom to query LTVs for
 */
export const useMarsLTVInfo = (marsMirrorContract: string | undefined, asset: string | undefined) => {
  const { appState } = useAppState()
  
  return useQuery({
    queryKey: ['mars_ltv_info', marsMirrorContract, asset, appState.rpcUrl],
    queryFn: async () => {
      if (!marsMirrorContract || !asset) return null
      return getMarsLTVInfo(appState.rpcUrl, marsMirrorContract, asset)
    },
    enabled: !!marsMirrorContract && !!asset,
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
}






















