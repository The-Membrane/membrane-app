import { getAssetByDenom, getAssets } from '@/helpers/chain'
import useAssets, { useAssetByDenom } from '@/hooks/useAssets'
import { useBasket } from '@/hooks/useCDP'
import useAppState from '@/persisted-state/useAppState'
import { useChainRoute } from '@/hooks/useChainRoute'
import { useMemo } from 'react'

export const useCollateralAssets = () => {
  const { appState } = useAppState()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { chainName } = useChainRoute()
  const assets = useAssets(chainName)
  // console.log("assets in collateral assets", assets)

  return useMemo(() => {
    // TODO(evm-migration): useBasket is a null-stub (no aggregate basket view in Cdp.sol),
    // so collateral types can't be derived yet. The mapping below re-activates unchanged
    // once getBasket is backed by a Collateral service.
    const collateralTypes = (basket as any)?.collateral_types as
      | { asset: any; max_borrow_LTV: any }[]
      | undefined

    return collateralTypes
      ?.map(({ asset, max_borrow_LTV }) => {
        const denom = asset?.info?.native_token?.denom || asset?.info?.token?.address
        const newAsset = assets?.find((a: any) => a.base === denom)

        if (!newAsset) return null
        return { ...newAsset, maxBorrowLTV: max_borrow_LTV }
      })
      .filter((asset) => !!asset)
  }, [basket, assets])
}

export default useCollateralAssets
