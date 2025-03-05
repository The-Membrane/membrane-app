import { getOracleAssetInfos, getOracleConfig, getOraclePrices } from '@/services/oracle'
import { useQuery } from '@tanstack/react-query'
import { useBasket } from './useCDP'
import { AssetInfo } from '@/contracts/codegen/oracle/Oracle.types'
import useAppState from '@/persisted-state/useAppState'

export const useOraclePrice = () => {
  const { data: basket, dataUpdatedAt } = useBasket()
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['oraclePrice', dataUpdatedAt, basket],
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

  return useQuery({
    queryKey: ['oracleConfig'],
    queryFn: async () => {
      return getOracleConfig(appState.rpcUrl)
    },
    refetchInterval: false,
    enabled: true,
    staleTime: 1000 * 60 * 5,
  })
}

export const useOracleAssetInfos = (assetInfos: AssetInfo[]) => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['oracleAssetInfos', assetInfos],
    queryFn: async () => {
      return getOracleAssetInfos(assetInfos, appState.rpcUrl)
    },
    refetchInterval: false,
    enabled: !!assetInfos,
    staleTime: 1000 * 60 * 5,
  })
}
