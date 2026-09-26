import { useQuery } from '@tanstack/react-query'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import useAppState from '@/persisted-state/useAppState'
import { getTransmuterTVL } from '@/services/flywheel'
import { getTransmuterRate, getTransmuterAPR, getTransmuterVolumeHistory, getTransmuterConfig, getTransmuterVaultInfo, getUserTransmuterDeposit, getUserTransmuterIntents } from '@/services/transmuter'
import useWallet from '@/hooks/useWallet'
import { shiftDigits } from '@/helpers/math'

/**
 * Hook to fetch Transmuter TVL
 */
export const useTransmuterTVL = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['transmuter', 'tvl', appState.rpcUrl],
        queryFn: async () => {
            return getTransmuterTVL(client)
        },
        staleTime: 1000 * 30, // 30 seconds
        enabled: true // Always enabled for mock data
    })
}

/**
 * Hook to fetch Transmuter rate/APR
 */
export const useTransmuterRate = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['transmuter', 'rate', appState.rpcUrl],
        queryFn: async () => {
            return getTransmuterRate(client)
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        enabled: true // Always enabled for mock data
    })
}

/**
 * Hook to fetch Transmuter APR
 */
export const useTransmuterAPR = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['transmuter', 'apr', appState.rpcUrl],
        queryFn: async () => {
            return getTransmuterAPR(client)
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        enabled: true // Always enabled for mock data
    })
}

/**
 * Hook to fetch Transmuter volume history
 */
export const useTransmuterVolumeHistory = (limit: number = 100) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['transmuter', 'volume_history', limit, appState.rpcUrl],
        queryFn: async () => {
            return getTransmuterVolumeHistory(client, undefined, limit)
        },
        staleTime: 1000 * 60 * 5,
        enabled: true // Always enabled for mock data
    })
}

/**
 * Aggregated hook for Transmuter data
 */
export const useTransmuterData = () => {
    const { data: tvl, isLoading: isLoadingTVL } = useTransmuterTVL()
    const { data: rate, isLoading: isLoadingRate } = useTransmuterRate()
    const { data: apr, isLoading: isLoadingAPR } = useTransmuterAPR()

    // Parse TVL from string (micro units) to number
    const tvlValue = tvl ? shiftDigits(tvl, -6).toNumber() : 0
    // Parse APR (already a number from mock, or convert if needed)
    const aprValue = apr !== null && apr !== undefined
        ? (typeof apr === 'number' ? apr : parseFloat(String(apr)) * 100)
        : null

    return {
        tvl: tvlValue,
        rate,
        apr: aprValue,
        isLoading: isLoadingTVL || isLoadingRate || isLoadingAPR,
    }
}

/**
 * Hook to fetch Transmuter config (usage_fee, utilization threshold)
 */
export const useTransmuterConfig = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['transmuter', 'config', appState.rpcUrl],
        queryFn: async () => {
            return getTransmuterConfig(client)
        },
        staleTime: 1000 * 60 * 5, // 5 minutes
        enabled: true,
    })
}

/**
 * Hook to fetch Transmuter vault info (balances for utilization calc)
 */
export const useTransmuterVaultInfo = () => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)

    return useQuery({
        queryKey: ['transmuter', 'vault_info', appState.rpcUrl],
        queryFn: async () => {
            return getTransmuterVaultInfo(client)
        },
        staleTime: 1000 * 30, // 30 seconds
        enabled: true,
    })
}

/**
 * Hook to fetch user's base transmuter deposit (vault tokens → USDC)
 * @param overrideAddress Optional address to use instead of connected wallet (for mock testing)
 */
/**
 * Hook to fetch user's intents from the transmuter contract
 * @param overrideAddress Optional address to use instead of connected wallet (for mock testing)
 */
export const useUserTransmuterIntents = (overrideAddress?: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { address } = useWallet()
    const queryAddr = overrideAddress || address

    return useQuery({
        queryKey: ['transmuter', 'user_intents', queryAddr, appState.rpcUrl],
        queryFn: async () => {
            return getUserTransmuterIntents(client || null, queryAddr || '')
        },
        enabled: !!queryAddr,
        staleTime: 1000 * 60, // 1 minute
    })
}

export const useUserTransmuterDeposit = (overrideAddress?: string) => {
    const { appState } = useAppState()
    const { data: client } = useCosmWasmClient(appState.rpcUrl)
    const { address } = useWallet()
    const queryAddr = overrideAddress || address

    return useQuery({
        queryKey: ['transmuter', 'user_deposit', queryAddr, appState.rpcUrl],
        queryFn: async () => {
            return getUserTransmuterDeposit(client || null, queryAddr || '')
        },
        enabled: !!queryAddr,
        staleTime: 1000 * 60, // 1 minute
    })
}

