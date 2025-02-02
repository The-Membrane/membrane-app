import { useQuery } from "@tanstack/react-query"

export const useCDTDailyVolume = () => {
    return useQuery({
        queryKey: ['cdt_daily_volume'],
        queryFn: async () => {
            const response = await fetch('/api/proxy'); // Calls your Next.js API route
            const data = await response.json();
            console.log("proxy log", data);
            return data;
        },
        staleTime: 1000 * 60 * 5,
    })
}