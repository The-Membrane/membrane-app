import { getOracleAssetInfos, getOracleConfig, getOraclePrices } from '@/services/oracle'
import { useQuery } from '@tanstack/react-query'
import { useBasket } from './useCDP'
import { AssetInfo } from '@/contracts/codegen/oracle/Oracle.types'

export const useOraclePrice = () => {
  const { data: basket, dataUpdatedAt } = useBasket()

  return useQuery({
    queryKey: ['oraclePrice', dataUpdatedAt, basket],
    queryFn: async () => {
      if (!basket) return
      return getOraclePrices(basket)
    },
    refetchInterval: false,
    enabled: !!basket,
    staleTime: 1000 * 60 * 5,
  })
}

export const useOracleConfig = () => {

  return useQuery({
    queryKey: ['oracleConfig'],
    queryFn: async () => {
      return getOracleConfig()
    },
    refetchInterval: false,
    enabled: true,
    staleTime: 1000 * 60 * 5,
  })
}

export const useOracleAssetInfos = (assetInfos: AssetInfo[]) => {
  return useQuery({
    queryKey: ['oracleAssetInfos', assetInfos],
    queryFn: async () => {
      return getOracleAssetInfos(assetInfos)
    },
    refetchInterval: false,
    enabled: !!assetInfos,
    staleTime: 1000 * 60 * 5,
  })
}
