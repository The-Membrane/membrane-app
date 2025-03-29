import { useQuery } from "@tanstack/react-query"
import { useRouter } from "next/router"

export const useCDTDailyVolume = () => {
    const router = useRouter()

    return useQuery({
        queryKey: ['cdt_daily_volume', router.pathname],
        queryFn: async () => {
            if (router.pathname != "/management") return
            const response = await fetch('/api/proxy'); // Calls your Next.js API route
            const data = await response.json();
            console.log("proxy log", data);
            return data as {
                volume_24h: number;
            };
        },
        staleTime: 1000 * 60 * 5,
    })
}