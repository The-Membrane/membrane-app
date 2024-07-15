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

export const useSoloLevel = () => {
    return useQuery({
      queryKey: ['one users points level'],
      queryFn: async () => {
        const { data: points } = useUserPoints()
        if (!points) return

        //1 Level every 9 points + 1 per level, so Level 1 = 9 points, Level 2 = 19 points, etc.
        const total_points = parseFloat(points.stats.total_points)
        //Set level
        var level = 1
        //Set level checkpoints every 10 so we can speed the logic up
        level = total_points >= 99 ? 10 : total_points >= 299 ? 30 : total_points >= 499 ? 50 : total_points >= 999 ? 100 : total_points >= 1999 ? 200 : total_points >= 2999 ? 300 : total_points >= 3999 ? 400 : total_points >= 4999 ? 500 : total_points >= 5999 ? 600 : total_points >= 6999 ? 700 : total_points >= 7999 ? 800 : total_points >= 8999 ? 900 : total_points >= 9999 ? 1000 : total_points >= 10999 ? 1100 : total_points >= 11999 ? 1200 : total_points >= 12999 ? 1300 : total_points >= 13999 ? 1400 : total_points >= 14999 ? 1500 : total_points >= 15999 ? 1600 : total_points >= 16999 ? 1700 : total_points >= 17999 ? 1800 : total_points >= 18999 ? 1900 : total_points >= 19999 ? 2000 : total_points >= 20999 ? 2100 : total_points >= 21999 ? 2200 : total_points >= 22999 ? 2300 : total_points >= 23999 ? 2400 : total_points >= 24999 ? 2500 : total_points >= 25999 ? 2600 : total_points >= 26999 ? 2700 : total_points >= 27999 ? 2800 : total_points >= 28999 ? 2900 : total_points >= 29999 ? 3000 : total_points >= 30999 ? 3100 : total_points >= 31999 ? 3200 : total_points >= 32999 ? 3300 : total_points >= 33999 ? 3400 : total_points >= 34999 ? 3500 : total_points >= 35999 ? 3600 : total_points >= 36999 ? 3700 : total_points >= 37999 ? 3800 : total_points >= 38999 ? 3900 : total_points >= 39999 ? 4000 : total_points >= 40999 ? 4100 : total_points >= 41999 ? 4200 : total_points >= 42999 ? 4300 : total_points >= 43999 ? 4400 : total_points >= 44999 ? 4500 : total_points >= 45999 ? 4600 : level

        //Find level
        while (true) {
          if (total_points >= (9 * level) + level-1) {
            level++
          } else {
            break
          }
        }

        const levelup_max_points = ((9 * ((level+1) - 1)) + ((level+1) - 1)) - total_points
        const points_in_level = total_points - ((9 * (level - 1)) + (level - 1))

        //Return level
        return { level, points_in_level, levelup_max_points }
      },
    })
}