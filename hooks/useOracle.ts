import { getOraclePrices } from '@/services/oracle'
import { useQuery } from '@tanstack/react-query'

export const useOraclePrice = () => {
  return useQuery({
    queryKey: ['oraclePrice'],
    queryFn: async () => {
      return getOraclePrices()
    },
    refetchInterval: 1000 * 60 * 10, // refetch every 10 minutes
  })
}
