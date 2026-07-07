import { useQuery } from '@tanstack/react-query'
import { useMemo } from 'react'
import type { Asset } from '@/helpers/chain'
import useAssets from '@/hooks/useAssets'
import { useBasket } from '@/hooks/useCDP'
import { getPublicClient } from '@/services/chain/client'
import { getErc20Metadata } from '@/services/chain/lens'
import type { Address } from '@/config/evm/contracts'
import useAppState from '@/persisted-state/useAppState'
import { useChainRoute } from '@/hooks/useChainRoute'

/**
 * Collateral assets for the bid/select UIs — derived from the lens-backed basket
 * (useBasket → services/chain/cdp.ts getBasket). Each entry is a resolved chain Asset
 * plus its `maxBorrowLTV` (currentMaxLTV, which IS the borrow-gating LTV in this port).
 *
 * Token metadata merge: collateral registered on-chain may not yet be listed in the static
 * registry (config/evm/tokens.ts). For those, symbol/decimals/name are read from the ERC20
 * directly (services/chain/lens.getErc20Metadata) and cached in a React Query, so assets
 * render before the static registry catches up.
 */
export const useCollateralAssets = () => {
  const { appState } = useAppState()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { chainName } = useChainRoute()
  const assets = useAssets(chainName)

  // Collateral token addresses the static registry doesn't know about yet.
  const missingTokens = useMemo(() => {
    if (!basket) return [] as Address[]
    const known = new Set((assets || []).map((a: Asset) => a.base?.toLowerCase()))
    return Array.from(
      new Set(
        basket.collateral_types
          .map((ct) => ct.asset.info.token.address)
          .filter((addr): addr is Address => !!addr && !known.has(addr.toLowerCase())),
      ),
    )
  }, [basket, assets])

  // Fetch + cache ERC20 metadata for the unknown collateral tokens.
  const { data: fetchedMeta } = useQuery({
    queryKey: ['collateral erc20 meta', missingTokens.join(','), appState.rpcUrl],
    queryFn: async () => {
      const client = getPublicClient()
      const entries = await Promise.all(missingTokens.map((t) => getErc20Metadata(client, t)))
      const map: Record<string, Asset> = {}
      for (const m of entries) {
        if (!m) continue
        map[m.address.toLowerCase()] = {
          base: m.address,
          symbol: m.symbol,
          name: m.name,
          decimal: m.decimals,
          logo: '',
          isLP: false,
        }
      }
      return map
    },
    enabled: missingTokens.length > 0,
    staleTime: 1000 * 60 * 60, // 1h — token metadata is effectively immutable
  })

  return useMemo(() => {
    if (!basket) return undefined
    return basket.collateral_types
      .map(({ asset, max_borrow_LTV }) => {
        const address = asset.info.token.address
        const registered = assets?.find((a: Asset) => a.base === address)
        const resolved = registered ?? fetchedMeta?.[address?.toLowerCase()]
        if (!resolved) return null
        return { ...resolved, maxBorrowLTV: max_borrow_LTV }
      })
      .filter((a): a is Asset & { maxBorrowLTV: string } => !!a)
  }, [basket, assets, fetchedMeta])
}

export default useCollateralAssets
