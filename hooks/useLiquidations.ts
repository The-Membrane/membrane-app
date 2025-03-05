import useWallet from '@/hooks/useWallet'
import { getLiquidationQueue, getUserClaims } from '@/services/liquidation'
import { getUserClaims as getSPUserClaims } from '@/services/stabilityPool'
import { getQueue } from '@/services/liquidation'
import { getCapitalAheadOfDeposit } from '@/services/stabilityPool'
import { getUserBids } from '@/services/liquidation'
import { getAssetPool } from '@/services/stabilityPool'
import useBidState from '@/components/Bid/hooks/useBidState'
import { useQuery } from '@tanstack/react-query'
import useAppState from '@/persisted-state/useAppState'
import { Asset } from '@/helpers/chain'

export const useCapitalAheadOfDeposit = () => {
    const { address } = useWallet()
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['capital ahead', address],
        queryFn: async () => {
            if (!address) return
            return getCapitalAheadOfDeposit(address, appState.rpcUrl)
        },
        enabled: !!address,
    })
}

export const useCheckClaims = () => {
    const { address } = useWallet()
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['liquidation claims', address],
        queryFn: async () => {
            if (!address) return
            return getUserClaims(address, appState.rpcUrl)
        },
        enabled: !!address,
    })
}

export const useLiquidation = (asset?: Asset) => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['liquidation info', asset?.base],
        queryFn: async () => {
            if (!asset) return []
            return getLiquidationQueue(asset, appState.rpcUrl)
        },
        enabled: !!asset?.base,
    })
}

export const useCheckSPClaims = () => {
    const { address } = useWallet()
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['stability pool claims', address],
        queryFn: async () => {
            if (!address) return
            return getSPUserClaims(address, appState.rpcUrl)
        },
        enabled: !!address,
    })
}

export const useQueue = (asset?: Asset) => {
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['queue', asset?.base],
        queryFn: async () => {
            if (!asset) return
            return getQueue(asset, appState.rpcUrl)
        },
        enabled: !!asset?.base,
    })
}

export const useUserBids = () => {
    const { address } = useWallet()
    const { appState } = useAppState()
    const { bidState } = useBidState()

    console.log("enabled", !!bidState?.selectedAsset?.base)
    return useQuery({
        queryKey: ['user bids', address, bidState?.selectedAsset?.base],
        queryFn: async () => {
            if (!address || !bidState?.selectedAsset?.base) return []
            return getUserBids(address, appState.rpcUrl, bidState?.selectedAsset?.base)
        },
        enabled: !!bidState?.selectedAsset?.base,
    })
}

export const useStabilityAssetPool = () => {
    const { address } = useWallet()
    const { appState } = useAppState()

    return useQuery({
        queryKey: ['stability asset pool', address],
        queryFn: async () => {
            if (!address) return
            return getAssetPool(address, appState.rpcUrl)
        },
        enabled: !!address,
    })
}