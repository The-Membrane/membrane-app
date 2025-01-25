import { getAssetByDenom, getAssets } from '@/helpers/chain'
import useAssets, { useAssetByDenom } from '@/hooks/useAssets'
import { useBasket } from '@/hooks/useCDP'
import { useMemo } from 'react'

const useCollateralAssets = () => {
  const { data: basket } = useBasket()

  const assets = useAssets()

  return useMemo(() => {

    return basket?.collateral_types
      ?.map(({ asset, max_borrow_LTV }) => {
        const denom = asset?.info?.native_token?.denom || asset?.info?.token?.address

        const newAsset = useAssetByDenom(denom, undefined, assets)

        if (!newAsset) return null
        return { ...newAsset, maxBorrowLTV: max_borrow_LTV }
      })
      .filter((asset) => !!asset)
  }, [basket, assets])
}

export default useCollateralAssets
