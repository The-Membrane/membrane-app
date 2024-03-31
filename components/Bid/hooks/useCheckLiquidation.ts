import { Asset } from '@/helpers/chain'
import { getLiquidationQueue } from '@/services/liquidation'
import { useQuery } from '@tanstack/react-query'

const useLiquidation = (asset?: Asset) => {
  return useQuery({
    queryKey: ['liquidation info', asset?.base],
    queryFn: async () => {
      if (!asset) return []
      return getLiquidationQueue(asset)
    },
    enabled: !!asset?.base,
  })
}

export default useLiquidation
