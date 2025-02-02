import { getCDTDailyVolume } from "@/services/numia"
import { useQuery } from "@tanstack/react-query"

export const useCDTDailyVolume = () => {
    return useQuery({
        queryKey: ['cdt_daily_volume'],
        queryFn: async () => {
            return getCDTDailyVolume()
        },
        staleTime: 1000 * 60 * 5,
    })
}