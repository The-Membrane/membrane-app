import { getCDTDailyVolume } from "@/services/numia"
import { useQuery } from "@tanstack/react-query"

export const useCDTDailyVolume = () => {
    return useQuery({
        queryKey: ['cdt_daily_volume'],
        queryFn: async () => {
            const response = await fetch("/api/proxy");
            const data = await response.json();
            return data;
        },
        staleTime: 1000 * 60 * 5,
    })
}