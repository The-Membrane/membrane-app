import { getOraclePrices } from '@/services/oracle'
import { useQuery } from '@tanstack/react-query'
import { useBasket } from './useCDP'

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
  })
}
