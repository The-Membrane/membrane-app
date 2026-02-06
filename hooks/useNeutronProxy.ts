import { useQuery } from '@tanstack/react-query'
import { getMBRNTokenInfo } from '@/services/neutronProxy'
import useAppState from '@/persisted-state/useAppState'

/**
 * Hook to get MBRN token info (including total supply) from neutron-proxy contract
 * 
 * @param neutronProxyContract - The neutron-proxy contract address (optional, will try to query from launch if not provided)
 * @param mbrnDenom - The MBRN denom (optional, will try to query from launch config if not provided)
 */
export const useMBRNTokenInfo = (neutronProxyContract?: string, mbrnDenom?: string) => {
  const { appState } = useAppState()
  
  // For now, we'll need to pass the contract address and denom directly
  // TODO: Query from launch contract if not provided
  return useQuery({
    queryKey: ['mbrn_token_info', neutronProxyContract, mbrnDenom, appState.rpcUrl],
    queryFn: async () => {
      if (!neutronProxyContract || !mbrnDenom) return null
      return getMBRNTokenInfo(appState.rpcUrl, neutronProxyContract, mbrnDenom)
    },
    enabled: !!neutronProxyContract && !!mbrnDenom,
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
}

