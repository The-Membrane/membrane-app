import { Asset } from '@/helpers/chain'
import { getQueue } from '@/services/liquidation'
import { useQuery } from '@tanstack/react-query'

const useQueue = (asset?: Asset) => {
  return useQuery({
    queryKey: ['queue', asset?.base],
    queryFn: async () => {
      if (!asset) return
      return getQueue(asset)
    },
    enabled: !!asset?.base,
  })
}

export default useQueue
