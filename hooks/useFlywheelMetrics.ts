import { useQueries } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getDiscoTotalInsurance, getTransmuterTVL, getManicTVL } from '@/services/flywheel'

// Mock data for flywheel metrics (in base units with 6 decimals)
const MOCK_FLYWHEEL_DATA = {
    discoInsurance: "12500000000", // 12.5M CDT
    transmuterTVL: "8500000000",   // 8.5M CDT
    manicTVL: "6200000000",        // 6.2M CDT
}

export const useFlywheelMetrics = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    const queries = useQueries({
        queries: [
            {
                queryKey: ['flywheel', 'disco', 'insurance', appState.rpcUrl],
                queryFn: () => getDiscoTotalInsurance(client || null),
                enabled: !!client,
                staleTime: 1000 * 60 * 5, // 5 minutes
                retry: 1,
            },
            {
                queryKey: ['flywheel', 'transmuter', 'tvl', appState.rpcUrl],
                queryFn: () => getTransmuterTVL(client || null),
                enabled: !!client,
                staleTime: 1000 * 60 * 5, // 5 minutes
                retry: 1,
            },
            {
                queryKey: ['flywheel', 'manic', 'tvl', appState.rpcUrl],
                queryFn: () => getManicTVL(client || null),
                enabled: !!client,
                staleTime: 1000 * 60 * 5, // 5 minutes
                retry: 1,
            }
        ]
    })

    const [discoQuery, transmuterQuery, manicQuery] = queries

    // Use mock data if no client or if queries failed/returned 0
    const useMockData = !client ||
        (discoQuery.data === "0" && transmuterQuery.data === "0" && manicQuery.data === "0") ||
        (discoQuery.isError && transmuterQuery.isError && manicQuery.isError)

    return {
        discoInsurance: useMockData ? MOCK_FLYWHEEL_DATA.discoInsurance : (discoQuery.data || "0"),
        transmuterTVL: useMockData ? MOCK_FLYWHEEL_DATA.transmuterTVL : (transmuterQuery.data || "0"),
        manicTVL: useMockData ? MOCK_FLYWHEEL_DATA.manicTVL : (manicQuery.data || "0"),
        isLoading: discoQuery.isLoading || transmuterQuery.isLoading || manicQuery.isLoading,
        isError: discoQuery.isError || transmuterQuery.isError || manicQuery.isError,
    }
}

