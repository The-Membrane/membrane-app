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
import { useRouter } from 'next/router'
import { useChainRoute } from './useChainRoute'

export const useCapitalAheadOfDeposit = () => {
    const { chainName } = useChainRoute()
    const { address } = useWallet(chainName)
    const { appState } = useAppState()
    const router = useRouter()

    return useQuery({
        queryKey: ['capital ahead', address, router.pathname, appState.rpcUrl],
        queryFn: async () => {
            if (!router.pathname.endsWith("/bid")) return
            if (!address) return
            return getCapitalAheadOfDeposit(address, appState.rpcUrl)
        },
        enabled: !!address,
    })
}

export const useCheckClaims = (run: boolean) => {
    const { chainName } = useChainRoute()
    const { address } = useWallet(chainName)
    const { appState } = useAppState()
    const router = useRouter()


    return useQuery({
        queryKey: ['liquidation claims', address, appState.rpcUrl, run, router.pathname],
        queryFn: async () => {
            if (!router.pathname.endsWith("/bid") && !run) return
            if (!address) return
            return getUserClaims(address, appState.rpcUrl)
        },
        enabled: !!address,
    })
}

export const useLiquidation = (asset?: Asset) => {
    const { appState } = useAppState()
    const router = useRouter()

    return useQuery({
        queryKey: ['liquidation info', asset?.base, router.pathname, appState.rpcUrl],
        queryFn: async () => {
            if (!router.pathname.endsWith("/bid")) return
            if (!asset) return []
            return getLiquidationQueue(asset, appState.rpcUrl)
        },
        enabled: !!asset?.base,
    })
}

export const useCheckSPClaims = (run: boolean) => {
    const { chainName } = useChainRoute()
    const { address } = useWallet(chainName)
    const { appState } = useAppState()
    const router = useRouter()

    return useQuery({
        queryKey: ['stability pool claims', address, appState.rpcUrl, run, router.pathname],
        queryFn: async () => {
            if (!router.pathname.endsWith("/bid") && !run) return
            if (!address) return
            return getSPUserClaims(address, appState.rpcUrl)
        },
        enabled: !!address,
    })
}

export const useQueue = (asset?: Asset) => {
    const { appState } = useAppState()
    const router = useRouter()

    return useQuery({
        queryKey: ['queue', asset?.base, router.pathname, appState.rpcUrl],
        queryFn: async () => {
            if (!router.pathname.endsWith("/bid")) return
            if (!asset) return
            return getQueue(asset, appState.rpcUrl)
        },
        enabled: !!asset?.base,
    })
}

export const useUserBids = () => {
    const { chainName } = useChainRoute()
    const { address } = useWallet(chainName)
    const { appState } = useAppState()
    const { bidState } = useBidState()
    const router = useRouter()

    console.log("enabled", !!bidState?.selectedAsset?.base)
    return useQuery({
        queryKey: ['user bids', address, bidState?.selectedAsset?.base, router.pathname, appState.rpcUrl],
        queryFn: async () => {
            if (!router.pathname.endsWith("/bid")) return
            if (!address || !bidState?.selectedAsset?.base) return []
            return getUserBids(address, appState.rpcUrl, bidState?.selectedAsset?.base)
        },
        enabled: !!bidState?.selectedAsset?.base,
    })
}

export const useStabilityAssetPool = (run: boolean) => {
    const { chainName } = useChainRoute()
    const { address } = useWallet(chainName)
    const { appState } = useAppState()
    const router = useRouter()

    return useQuery({
        queryKey: ['stability asset pool', address, router.pathname, appState.rpcUrl, run],
        queryFn: async () => {
            if (!router.pathname.endsWith("/bid") && !run) return
            if (!address) return
            return getAssetPool(address, appState.rpcUrl)
        },
        enabled: !!address,
    })
}