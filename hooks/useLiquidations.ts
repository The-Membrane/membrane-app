import useWallet from '@/hooks/useWallet'
import { getLiquidationQueue } from '@/services/liquidation'
import { getQueue } from '@/services/liquidation'
import { getUserBids } from '@/services/liquidation'
import {
  assetKey,
  getClaimableCollateral,
  getUserBids as getEvmUserBids,
} from '@/services/chain/liquidation'
import { getPublicClient } from '@/services/chain/client'
import type { Address } from '@/config/evm/contracts'
import type { ClaimsResponse } from '@/contracts/codegen/liquidation_queue/LiquidationQueue.types'
import useAssets from '@/hooks/useAssets'
import useBidState from '@/components/Bid/hooks/useBidState'
import { useQuery } from '@tanstack/react-query'
import useAppState from '@/persisted-state/useAppState'
import { Asset } from '@/helpers/chain'
import { useRouter } from 'next/router'
import { useChainRoute } from './useChainRoute'

/**
 * Liquidation query hooks.
 *
 * MIGRATION STATE (evm-migration):
 *   - useCheckClaims — EVM. Reconstructs pending liquidation collateral per asset from
 *     services/chain/liquidation (getClaimableCollateral + getUserBids), producing the
 *     same ClaimsResponse[] shape ({ bid_for, pending_liquidated_collateral }) that
 *     useClaimLiquidation / claimstoCoins consume. `bid_for` is the asset's ERC-20 base
 *     address so assetKey(bid_for) on the write path derives the SAME LiqQueue bytes32
 *     key used here (read/write self-consistent; the on-chain key convention itself is
 *     deployment-defined — see assetKey() TODO in services/chain/liquidation.ts).
 *   - useCheckSPClaims / useStabilityAssetPool / useCapitalAheadOfDeposit — honest
 *     null-stubs. There is no stability pool in the Solidity port
 *     (inv_no_stability_pool); LiquidationEngine/LtvDisco replace it by design.
 *   - useLiquidation / useQueue / useUserBids — still on the CosmWasm services
 *     (services/liquidation.ts). These power the /liquidate bid-book display (RiskChart,
 *     bid list), a separate un-migrated sub-domain whose consumer shapes differ from the
 *     EVM premium-slot views; left untouched here. TODO(evm-migration).
 */

export const useCapitalAheadOfDeposit = () => {
    // TODO(evm-migration): no stability pool in the port — LiquidationEngine/LtvDisco replace it
    return useQuery({
        queryKey: ['capital ahead', 'stub'],
        queryFn: async (): Promise<any> => null,
        enabled: false,
    })
}

export const useCheckClaims = (run: boolean) => {
    const { address } = useWallet()
    const assets = useAssets()
    const router = useRouter()

    return useQuery<ClaimsResponse[]>({
        queryKey: ['liquidation claims', address, run, router.pathname, (assets ?? []).map((a) => a.base).join(',')],
        queryFn: async (): Promise<ClaimsResponse[]> => {
            if (!router.pathname.endsWith("/liquidate") && !run) return []
            if (!address || !assets) return []

            const client = getPublicClient()

            const perAsset = await Promise.all(
                assets
                    .filter((a) => !!a.base)
                    .map(async (a) => {
                        const key = assetKey(a.base)
                        const [claimable, bids] = await Promise.all([
                            getClaimableCollateral(client, key, address as Address),
                            getEvmUserBids(client, key, address as Address),
                        ])
                        // claimableCollateral = already-drained aggregate; per-bid
                        // pendingLiquidatedCollateral = collateral accrued to still-active bids.
                        const pendingFromBids = (bids ?? []).reduce(
                            (acc, b) => acc + b.pendingLiquidatedCollateral,
                            0n,
                        )
                        const total = (claimable ?? 0n) + pendingFromBids
                        if (total <= 0n) return null
                        return {
                            bid_for: a.base,
                            pending_liquidated_collateral: total.toString(),
                        } as ClaimsResponse
                    }),
            )

            return perAsset.filter((c): c is ClaimsResponse => c !== null)
        },
        enabled: !!address,
        staleTime: 1000 * 60,
    })
}

export const useLiquidation = (asset?: Asset) => {
    const { appState } = useAppState()
    const router = useRouter()

    return useQuery({
        queryKey: ['liquidation info', asset?.base, router.pathname, appState.rpcUrl],
        queryFn: async () => {
            if (!router.pathname.endsWith("/liquidate")) return
            if (!asset) return []
            return getLiquidationQueue(asset, appState.rpcUrl)
        },
        enabled: !!asset?.base,
    })
}

export const useCheckSPClaims = (_run: boolean) => {
    // TODO(evm-migration): no stability pool in the port — LiquidationEngine/LtvDisco replace it
    return useQuery({
        queryKey: ['stability pool claims', 'stub'],
        queryFn: async (): Promise<any> => undefined,
        enabled: false,
    })
}

export const useQueue = (asset?: Asset) => {
    const { appState } = useAppState()
    const router = useRouter()

    return useQuery({
        queryKey: ['queue', asset?.base, router.pathname, appState.rpcUrl],
        queryFn: async () => {
            if (!router.pathname.endsWith("/liquidate")) return
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

    return useQuery({
        queryKey: ['user bids', address, bidState?.selectedAsset?.base, router.pathname, appState.rpcUrl],
        queryFn: async () => {
            if (!router.pathname.endsWith("/liquidate")) return
            if (!address || !bidState?.selectedAsset?.base) return []
            return getUserBids(address, appState.rpcUrl, bidState?.selectedAsset?.base)
        },
        enabled: !!bidState?.selectedAsset?.base,
    })
}

export const useStabilityAssetPool = (_run: boolean) => {
    // TODO(evm-migration): no stability pool in the port — LiquidationEngine/LtvDisco replace it
    return useQuery({
        queryKey: ['stability asset pool', 'stub'],
        queryFn: async (): Promise<any> => null,
        enabled: false,
    })
}
