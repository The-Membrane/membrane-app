import { getOraclePrices } from '@/services/oracle'
import { useQuery } from '@tanstack/react-query'
import { useBasket } from './useCDP'

export const useOraclePrice = () => {
  const { data: basket, dataUpdatedAt } = useBasket()

  return useQuery({
    queryKey: ['oraclePrice', dataUpdatedAt],
    queryFn: async () => {
      if (!basket) return
      return getOraclePrices(basket)
    },
    refetchInterval: 1000 * 60 * 10, // refetch every 10 minutes
    enabled: !!basket,
  })
}
