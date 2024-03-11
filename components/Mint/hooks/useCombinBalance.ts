import { Asset } from '@/helpers/chain'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import useBalance from '@/hooks/useBalance'
import { useBasket, useBasketPositions, useCollateralInterest } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getBasketAssets, getPositionAssets } from '@/services/cdp'
import { useMemo } from 'react'
import useMintState from './useMintState'

export type AssetWithBalance = Asset & {
  sliderValue?: number
  walletBalance: number
  walletsdValue: number
  deposited: number
  depositUsdValue: number
  combinBalance: number
  combinUsdValue: number
  price: number
  amount?: string | number
}
//returns an array of assets with their balances and values from the wallet & position
const useCombinBalance = () => {
  const { data: collateralInterest } = useCollateralInterest()
  const { data: prices } = useOraclePrice()
  const { data: balances } = useBalance()
  const { data: basketPositions } = useBasketPositions()
  const { data: basket } = useBasket()
  const { mintState } = useMintState()

  return useMemo(() => {
    const basketAssets = getBasketAssets(basket!, collateralInterest!)
    const positionAssets = getPositionAssets(mintState.index, basketPositions, prices)

    return basketAssets?.map((basket_asset) => {
      const positionAsset = positionAssets.find((p) => p.denom === basket_asset.asset.base)
      const balance = balances?.find((b) => b.denom === basket_asset.asset.base) || { amount: '0' }
      const balanceInMicro = shiftDigits(balance.amount, -basket_asset.asset.decimal).toNumber()
      const combinBalance = num(balanceInMicro || 0)
        .plus(positionAsset?.amount || 0)
        .toNumber()
      const price = prices?.find((p) => p.denom === basket_asset.asset.base)?.price || 0
      const walletsdValue = num(balanceInMicro).times(price).toNumber()
      const depositUsdValue = num(positionAsset?.usdValue || 0)
        .dp(2)
        .toNumber()
      const combinUsdValue = num(combinBalance).times(price).dp(2).toNumber()
      return {
        ...basket_asset.asset,
        walletBalance: Number(balanceInMicro),
        walletsdValue,
        deposited: positionAsset?.amount,
        depositUsdValue,
        combinBalance,
        combinUsdValue,
        price,
      }
    }) as AssetWithBalance[]
  }, [balances, basketPositions, basket, prices, mintState.index])
}

export default useCombinBalance
