import { useQuery } from '@tanstack/react-query'
import { getAllUserPoints } from '@/services/points'
import useWallet from './useWallet'

export const useAllUserPoints = () => {
  return useQuery({
    queryKey: ['all users points'],
    queryFn: async () => {
      return getAllUserPoints()
    },
  })
}

export const useUserPoints = () => {
    return useQuery({
      queryKey: ['one users points'],
      queryFn: async () => {
        const { address } = useWallet()
        const { data: points } = useAllUserPoints()
        if (!points) return
        return points.find((point) => point.user === address)
      },
    })
}

export const useUserPointRanking = () => {
    return useQuery({
      queryKey: ['one users points ranking'],
      queryFn: async () => {
        const { address } = useWallet()
        const { data: points } = useAllUserPoints()
        if (!points) return

        //Sort points by points.stats.total_points
        points.sort((a, b) => parseFloat(b.stats.total_points) - parseFloat(a.stats.total_points))

        return points.findIndex((point) => point.user === address) + 1
      },
    })
}