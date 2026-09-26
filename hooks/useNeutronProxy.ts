import { useQuery } from '@tanstack/react-query'
import { getMBRNTokenInfo, getMBRNSupplyHistory } from '@/services/neutronProxy'
import useAppState from '@/persisted-state/useAppState'

/**
 * Hook to get MBRN token info (including total supply) from neutron-proxy contract
 */
export const useMBRNTokenInfo = (neutronProxyContract?: string, mbrnDenom?: string) => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['mbrn_token_info', neutronProxyContract, mbrnDenom, appState.rpcUrl],
    queryFn: async () => {
      if (!neutronProxyContract || !mbrnDenom) return null
      return getMBRNTokenInfo(appState.rpcUrl, neutronProxyContract, mbrnDenom)
    },
    enabled: !!neutronProxyContract && !!mbrnDenom,
    staleTime: 1000 * 60 * 5,
  })
}

/**
 * Hook to get MBRN supply history snapshots from proxy contract
 */
export const useMBRNSupplyHistory = (proxyContract?: string, mbrnDenom?: string) => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['mbrn_supply_history', proxyContract, mbrnDenom, appState.rpcUrl],
    queryFn: async () => {
      if (!proxyContract || !mbrnDenom) return null
      return getMBRNSupplyHistory(appState.rpcUrl, proxyContract, mbrnDenom)
    },
    enabled: !!proxyContract && !!mbrnDenom,
    staleTime: 1000 * 60 * 5,
  })
}
