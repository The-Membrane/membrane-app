import { getAssetByDenom, getAssets } from '@/helpers/chain'
import { useBasket } from '@/hooks/useCDP'
import { useMemo } from 'react'

const useCollateralAssets = () => {
  const { data: basket } = useBasket()

  const assets = getAssets("osmosis")

  return useMemo(() => {
    return basket?.collateral_types
      ?.map(({ asset, max_borrow_LTV }) => {
        const denom = asset?.info?.native_token?.denom || asset?.info?.token?.address
        const newAsset = assets?.find((asset) => asset.base === denom)
        if (!newAsset) return null
        return { ...newAsset, maxBorrowLTV: max_borrow_LTV }
      })
      .filter((asset) => !!asset)
  }, [basket, assets])
}

export default useCollateralAssets
