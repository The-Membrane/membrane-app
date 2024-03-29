import { getAssetByDenom } from '@/helpers/chain'
import { useBasket } from '@/hooks/useCDP'
import { useMemo } from 'react'

const useCollateralAssets = () => {
  const { data: basket } = useBasket()

  return useMemo(() => {
    return basket?.collateral_types
      ?.map(({ asset }) => {
        const denom = asset?.info?.native_token?.denom || asset?.info?.token?.address
        const newAsset = getAssetByDenom(denom)
        return newAsset
      })
      .filter((asset) => !!asset)
  }, [basket])
}

export default useCollateralAssets
