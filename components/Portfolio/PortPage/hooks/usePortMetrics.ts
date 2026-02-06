import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import useWallet from '@/hooks/useWallet'
import { aggregateRevenue } from '@/services/portMetrics'
import { useDiscoAssets } from '@/hooks/useDiscoData'

/**
 * Hook to aggregate revenue metrics from all sources
 */
export const usePortMetrics = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { address } = useWallet()
    const { data: discoAssets } = useDiscoAssets()

    // getAssets returns { assets: [...] } or null
    const assetList = Array.isArray(discoAssets?.assets)
        ? discoAssets.assets.map((asset: any) => typeof asset === 'string' ? asset : asset.denom || asset)
        : Array.isArray(discoAssets)
            ? discoAssets.map((asset: any) => typeof asset === 'string' ? asset : asset.denom || asset)
            : []

    return useQuery({
        queryKey: ['port_metrics', address, assetList, appState.rpcUrl],
        queryFn: async () => {
            // Always return data (mock if needed)
            return aggregateRevenue(client || null, address || 'mock-user', assetList)
        },
        enabled: true, // Always enabled to show mock data
        staleTime: 1000 * 30, // 30 seconds
    })
}
