import { useQuery } from "@tanstack/react-query"
import { useRouter } from "next/router"

export const useCDTDailyVolume = () => {
    const router = useRouter()

    return useQuery({
        queryKey: ['cdt_daily_volume', router.pathname],
        queryFn: async () => {
            // Only /control-room ever fetched this. That page was removed 2026-10-12
            // (docs/CUTS-2026-10-12.md); the guard stays so the remaining caller
            // (components/Home/RangeBoundInfoCard.tsx) keeps never fetching.
            if (!router.pathname.endsWith("/control-room")) return
            const response = await fetch('/api/proxy'); // Calls your Next.js API route
            const data = await response.json();
            return data as {
                volume_24h: number;
            };
        },
        staleTime: 1000 * 60 * 5,
    })
}