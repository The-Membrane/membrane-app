import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getCurrentEpochRevenue, getEpochCountdown } from '@/services/revenueDistributor'
import contracts from '@/config/contracts.json'

/**
 * Hook to get current epoch revenue accumulation
 * TODO: Get revenue_distributor address from contracts.json or query from CDP/Disco config
 */
export const useCurrentEpochRevenue = (revenueDistributorAddr?: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    
    // TODO: Get from contracts.json or query from CDP/Disco config
    const contractAddr = revenueDistributorAddr || (contracts as any).revenue_distributor

    return useQuery({
        queryKey: ['revenue_distributor', 'current_epoch_revenue', contractAddr, appState.rpcUrl],
        queryFn: () => getCurrentEpochRevenue(client || null, contractAddr || ''),
        enabled: !!client && !!contractAddr && contractAddr !== '',
        staleTime: 1000 * 30, // 30 seconds - refresh frequently for countdown
        refetchInterval: 1000 * 30, // Refetch every 30 seconds
    })
}

/**
 * Hook to get epoch countdown information
 * TODO: Get revenue_distributor address from contracts.json or query from CDP/Disco config
 */
export const useEpochCountdown = (revenueDistributorAddr?: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    
    // TODO: Get from contracts.json or query from CDP/Disco config
    const contractAddr = revenueDistributorAddr || (contracts as any).revenue_distributor

    return useQuery({
        queryKey: ['revenue_distributor', 'epoch_countdown', contractAddr, appState.rpcUrl],
        queryFn: () => getEpochCountdown(client || null, contractAddr || ''),
        enabled: !!client && !!contractAddr && contractAddr !== '',
        staleTime: 1000 * 10, // 10 seconds - refresh very frequently for countdown
        refetchInterval: 1000 * 10, // Refetch every 10 seconds for live countdown
    })
}


