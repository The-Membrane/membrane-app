import { Asset } from '@/helpers/chain'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import useBalance from '@/hooks/useBalance'
import { useBasket, useUserPositions, useCollateralInterest } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getBasketAssets, getPositions } from '@/services/cdp'
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
  inputAmount?: number
}

const useCombinBalance = (positionIndex: number = 0) => {
  const { data: collateralInterest } = useCollateralInterest()
  const { data: prices } = useOraclePrice()
  const { data: balances } = useBalance()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket()

  return useMemo(() => {
    const basketAssets = getBasketAssets(basket!, collateralInterest!)
    const positions = getPositions(basketPositions, prices, positionIndex)
    if (!positions) return []

    return basketAssets?.map((asset) => {
      const position = positions.find((p) => p.denom === asset.asset.base)
      const balance = balances?.find((b) => b.denom === asset.asset.base) || { amount: '0' }
      const balanceInMicro = shiftDigits(balance.amount, -asset.asset.decimal || -18).toNumber()
      const combinBalance = num(balanceInMicro || 0)
        .plus(position?.amount || 0)
        .toNumber()
      const price = prices?.find((p) => p.denom === asset.asset.base)?.price || 0
      const walletsdValue = num(balanceInMicro).times(price).toNumber()
      const depositUsdValue = num(position?.usdValue || 0).toNumber()
      const combinUsdValue = num(combinBalance).times(price).toNumber()
      return {
        ...asset.asset,
        walletBalance: Number(balanceInMicro),
        walletsdValue,
        deposited: position?.amount || 0,
        depositUsdValue,
        combinBalance,
        combinUsdValue,
        price,
      }
    }) as AssetWithBalance[]
  }, [balances, basketPositions, basket, prices, positionIndex])
}

export default useCombinBalance
