import { Asset, getChainAssets } from '@/helpers/chain'
import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'

const useAssets = () => {
  const { data: assets } = useQuery({
    queryKey: ['assets'],
    queryFn: async () => {
      return getChainAssets()
    },
  })

  return assets as Asset[]
}

export const useAssetBySymbol = (symbol: string) => {
  const assets = useAssets()

  return useMemo(() => {
    if (!assets || !symbol) return null
    return assets.find((asset) => asset.symbol === symbol) as Asset
  }, [assets, symbol])
}

export default useAssets
