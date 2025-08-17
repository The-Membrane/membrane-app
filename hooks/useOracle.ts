import { getOracleAssetInfos, getOracleConfig, getOraclePrices } from '@/services/oracle'
import { useQuery } from '@tanstack/react-query'
import { useBasket } from './useCDP'
import { AssetInfo } from '@/contracts/codegen/oracle/Oracle.types'
import useAppState from '@/persisted-state/useAppState'
import { useRouter } from 'next/router'
import { useChainRoute } from './useChainRoute'

export const useOraclePrice = () => {
  const { chainName } = useChainRoute()
  const { appState } = useAppState()
  const { data: basket, dataUpdatedAt } = useBasket(appState.rpcUrl)

  return useQuery({
    queryKey: ['oraclePrice', dataUpdatedAt, basket, appState.rpcUrl],
    queryFn: async () => {
      if (!basket) return
      return getOraclePrices(basket, appState.rpcUrl)
    },
    refetchInterval: false,
    enabled: !!basket,
    staleTime: 1000 * 60 * 5,
  })
}

export const useOracleConfig = () => {
  const { appState } = useAppState()
  const router = useRouter()

  return useQuery({
    queryKey: ['oracleConfig', router.pathname, appState.rpcUrl],
    queryFn: async () => {
      if (!router.pathname.endsWith("/control-room")) return
      return getOracleConfig(appState.rpcUrl)
    },
    refetchInterval: false,
    enabled: true,
    staleTime: 1000 * 60 * 5,
  })
}

export const useOracleAssetInfos = (assetInfos: AssetInfo[]) => {
  const { appState } = useAppState()
  const router = useRouter()

  return useQuery({
    queryKey: ['oracleAssetInfos', assetInfos, router.pathname, appState.rpcUrl],
    queryFn: async () => {
      if (!router.pathname.endsWith("/control-room") && !router.pathname.endsWith("/isolated")) return []
      return getOracleAssetInfos(assetInfos, appState.rpcUrl)
    },
    refetchInterval: false,
    enabled: !!assetInfos,
    staleTime: 1000 * 60 * 5,
  })
}
