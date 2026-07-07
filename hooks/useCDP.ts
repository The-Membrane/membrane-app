import { useQuery } from '@tanstack/react-query'
import { formatEther } from 'viem'
import { useRouter } from 'next/router'
import { getAssets, type Asset } from '@/helpers/chain'
import type { BasketAsset } from '@/services/cdp'
import { useChainRoute } from '@/hooks/useChainRoute'
import useWallet from '@/hooks/useWallet'
import useAppState from '@/persisted-state/useAppState'
import { getPublicClient } from '@/services/chain/client'
import type { Address } from '@/config/evm/contracts'
import {
  getBasket,
  getRatesConfig,
  getCollateralInterest,
  getCreditRate,
  getUserRedemptionInfo,
  getUserPositions,
  getUserBorrowRateDiscount,
  getBasketPositions,
} from '@/services/chain/cdp'

/**
 * CDP domain hooks — migrated from CosmWasm (PositionsQueryClient / queryContractSmart)
 * to EVM (viem PublicClient via services/chain/cdp.ts). Hook names, React Query keys, and
 * staleTime tiers are preserved so downstream imports keep resolving; the queryFns now call
 * the EVM service layer. Where Cdp.sol has no equivalent view, the underlying service returns
 * null (see the getBasket / getRates / getBasketPositions / redemption stubs) — those hooks
 * therefore resolve to null-ish data with the reason documented in the service.
 *
 * The rpcUrl args are retained for signature compatibility with existing call sites; the EVM
 * public client is chain-configured and wallet-independent (services/chain/client.ts).
 */

export const useBasket = (rpcUrl: string) => {
  return useQuery({
    queryKey: ['basket', rpcUrl],
    queryFn: async () => {
      // Legacy-shaped basket sourced from FrontendLens.getAllCollateralParams
      // (services/chain/cdp.ts getBasket → services/chain/lens.ts). credit_price is not part
      // of this shape — read it via useCreditRate / getCreditPrice where needed.
      return getBasket(getPublicClient())
    },
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
}

export const useRates = (rpcUrl: string) => {
  return useQuery({
    queryKey: ['rates', rpcUrl],
    queryFn: async () => {
      return getRatesConfig(getPublicClient())
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useBasketAssets = () => {
  const { appState } = useAppState()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: interest } = useCollateralInterest()

  return useQuery({
    queryKey: ['get_basket_assets', basket, interest, appState.rpcUrl],
    queryFn: async () => {
      // Rebuild the legacy BasketAsset[] shape (services/cdp.ts consumers read
      // .asset.base / .interestRate / .maxLTV / .maxBorrowLTV / .rateIndex / .supplyCapRatio)
      // from the lens-backed basket + per-collateral adaptive interest. Matched by bytes32
      // denom. rateIndex has no lens equivalent (Cdp.sol has no cumulative index) → 0.
      if (!basket) return [] as BasketAsset[]
      const assets = getAssets()
      return basket.collateral_types.map((ct): BasketAsset => {
        const address = ct.asset.info.token.address
        const chainAsset = assets?.find((a: Asset) => a.base === address)
        // Fallback keeps the BasketAsset.asset shape (Asset) intact when a collateral token
        // isn't in the static registry; symbol/decimals are resolved for display where a
        // component needs them (see components/Bid/hooks/useCollateralAssets erc20 merge).
        const asset: Asset =
          chainAsset ?? { base: address, symbol: '', name: '', decimal: 18, logo: '', isLP: false }
        const rateEntry = (interest || []).find((r) => r.denom === ct.denom)
        const interestRate = rateEntry ? Number(formatEther(rateEntry.rate)) : 0
        return {
          asset,
          interestRate,
          rateIndex: 0,
          maxLTV: Number(ct.max_LTV),
          maxBorrowLTV: Number(ct.max_borrow_LTV),
          supplyCapRatio: ct.supply_cap_ratio,
        }
      })
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useCollateralInterest = () => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['collateral interest', appState.rpcUrl],
    queryFn: async () => {
      return getCollateralInterest(getPublicClient())
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useCreditRate = () => {
  const { appState } = useAppState()
  const router = useRouter()

  return useQuery({
    queryKey: ['credit rate', router.pathname, appState.rpcUrl],
    queryFn: async () => {
      if (!router.pathname.endsWith('/mint') && !router.pathname.endsWith('/portfolio')) return null
      // TODO(evm-migration): getCreditRate is a stub — no credit-redemption-rate view in
      // Cdp.sol (CPC-driven). Use getCreditPrice/getRatesConfig from the service instead.
      return getCreditRate(getPublicClient())
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserRemptionInfo = () => {
  const { appState } = useAppState()
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const router = useRouter()

  return useQuery({
    queryKey: ['user_redemption_info', address, router.pathname, appState.rpcUrl],
    queryFn: async () => {
      if (!router.pathname.endsWith('/mint') && !router.pathname.endsWith('/portfolio')) return null
      if (!address) return null
      // TODO(evm-migration): getUserRedemptionInfo is a stub — no redeemability view ported
      // to Cdp.sol.
      return getUserRedemptionInfo(getPublicClient(), address as Address)
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useUserPositions = () => {
  const { chainName } = useChainRoute()
  const { address } = useWallet(chainName)
  const { appState } = useAppState()
  const router = useRouter()

  return useQuery({
    queryKey: ['positions', address, router.pathname, appState.rpcUrl],
    queryFn: async () => {
      if (!router.pathname.endsWith('/mint') && !router.pathname.endsWith('/portfolio')) return []
      if (!address) return []
      // NOTE: returns EvmUserPosition[] (flat Solidity shape), not the CosmWasm
      // BasketPositionsResponse[]. Consumers using the legacy getPositions/getDebt transforms
      // must be adapted to this shape.
      return getUserPositions(getPublicClient(), address as Address)
    },
    enabled: true,
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
}

export const useUserDiscount = (address: string | undefined) => {
  const { appState } = useAppState()
  const router = useRouter()

  return useQuery({
    queryKey: ['user', 'discount', 'cdp', address, router.pathname, appState.rpcUrl],
    queryFn: async () => {
      if (!router.pathname.endsWith('/mint') && !router.pathname.endsWith('/portfolio')) return null
      if (!address) return { user: '', discount: '0' }
      // Cdp.sol borrowRateDiscount delegates to systemDiscounts.getDiscountFor(user);
      // it is 1e18-fractional, so normalize to the 0..1 string the old shape used.
      const raw = await getUserBorrowRateDiscount(getPublicClient(), address as Address)
      const discount = raw === null ? '0' : (Number(raw) / 1e18).toString()
      return { user: address, discount }
    },
    staleTime: 1000 * 60 * 5,
  })
}

export const useBasketPositions = () => {
  const { appState } = useAppState()

  return useQuery({
    queryKey: ['all positions', appState.rpcUrl],
    queryFn: async () => {
      // TODO(evm-migration): getBasketPositions is a stub — Cdp.sol has no protocol-wide
      // position enumeration (userPositionIds is per-owner only). Needs an indexer.
      return getBasketPositions(getPublicClient())
    },
    staleTime: 1000 * 60 * 5,
  })
}
