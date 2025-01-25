import { Asset, getAssets } from '@/helpers/chain'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

const useAssets = (chainID: string = 'osmosis') => {
  const { data: assets } = useQuery({
    queryKey: [chainID + ' assets'],
    queryFn: async () => {
      return getAssets(chainID)
    },
  })

  return assets as Asset[]
}

export const useAssetBySymbol = (symbol: string, chainID: string = 'osmosis') => {
  const assets = useAssets(chainID)

  return useMemo(() => {
    if (!assets || !symbol || (assets && assets.length == 0)) { console.log("ffff", assets, symbol); return null }
    return assets?.find((asset) => asset.symbol === symbol) as Asset
  }, [assets, symbol])
}

export default useAssets
