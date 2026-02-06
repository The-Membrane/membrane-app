import { useQuery } from '@tanstack/react-query'
import { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'
import type { MarketNode, FlowEdge, SystemEvent, TimelineData } from '@/types/visualization'
import { getVisualizationData } from '@/services/visualization'

interface VisualizationDataResponse {
    markets: MarketNode[]
    flows: FlowEdge[]
    events: SystemEvent[]
    timelineData: TimelineData
}

export const useVisualizationData = (
    cosmWasmClient: CosmWasmClient | null | undefined,
    timeRange: '1h' | '24h' | '7d' | '30d'
) => {
    const query = useQuery<VisualizationDataResponse>({
        queryKey: ['visualization_data', cosmWasmClient, timeRange],
        queryFn: async () => {
            // If no client, return mock data immediately
            if (!cosmWasmClient) {
                const { getMockMarkets, getMockFlows, getMockEvents, getMockTimelineData } = await import('@/services/visualization')
                const now = Math.floor(Date.now() / 1000)
                const timeRangeSeconds = {
                    '1h': 3600,
                    '24h': 86400,
                    '7d': 604800,
                    '30d': 2592000,
                }[timeRange]
                const startTime = now - timeRangeSeconds

                return {
                    markets: getMockMarkets(),
                    flows: getMockFlows(startTime, now),
                    events: getMockEvents(startTime, now),
                    timelineData: getMockTimelineData(startTime, now),
                }
            }
            return getVisualizationData(cosmWasmClient, timeRange)
        },
        enabled: true, // Always enabled, will use mock data if no client
        refetchInterval: 10000, // Refetch every 10 seconds for real-time updates
        staleTime: 5000,
    })

    return {
        markets: query.data?.markets || [],
        flows: query.data?.flows || [],
        events: query.data?.events || [],
        timelineData: query.data?.timelineData || {
            timestamps: [],
            cdtSupply: [],
            mbrnAtRisk: [],
            liquidationClusters: [],
            riskMetrics: [],
        },
        isLoading: query.isLoading,
        error: query.error,
    }
}

