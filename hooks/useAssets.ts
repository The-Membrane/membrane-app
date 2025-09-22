import { Asset, getAssets } from '@/helpers/chain'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import { DEFAULT_CHAIN } from '@/config/chains'

const useAssets = (chainID: string = DEFAULT_CHAIN) => {
  const { data: assets } = useQuery({
    queryKey: [chainID + ' assets'],
    queryFn: async () => {
      return getAssets(chainID)
    },
  })

  return assets as Asset[]
}

export const useAssetBySymbol = (symbol: string, chainID: string = DEFAULT_CHAIN) => {
  const assets = useAssets(chainID)

  return useMemo(() => {
    if (!assets || !symbol) return null
    return assets.find((asset) => asset.symbol === symbol) as Asset
  }, [assets, symbol])
}

export const useAssetByDenom = (denom: string, chainID: string = DEFAULT_CHAIN, assets: any[]) => {
  return useMemo(() => {
    if (!assets || !denom) return null
    return assets.find((asset) => asset.base === denom)
  }, [assets, denom])
}

export default useAssets
