import { Asset } from '@/helpers/chain'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import useBalance from '@/hooks/useBalance'
import { useBasket, useUserPositions, useCollateralInterest, useBasketAssets } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { getPositions } from '@/services/cdp'
import { useMemo } from 'react'
import useMintState from './useMintState'
import useAppState from '@/persisted-state/useAppState'
import { useChainRoute } from '@/hooks/useChainRoute'

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
  maxBorrowLTV?: number
}

const useCombinBalance = (positionIndex: number = 0) => {
  const { appState } = useAppState()
  const { data: prices } = useOraclePrice()
  const { data: balances } = useBalance()
  const { data: basketPositions } = useUserPositions()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: basketAssets } = useBasketAssets()
  const { chainName } = useChainRoute()

  return useMemo(() => {
    const positions = getPositions(basketPositions, prices, positionIndex, chainName)
    if (!positions) return []

    return basketAssets?.map((asset, index) => {
      const position = positions.find((p) => p.denom === asset.asset.base)
      //if its collateral supply cap is 0, it is not a valid asset
      if (basket?.collateral_supply_caps[index].supply_cap_ratio === '0' && position?.amount === 0) return
      // console.log("asset.supplyCapRatio:", asset.supplyCapRatio, position?.amount, asset.asset.symbol)
      //
      const balance = balances?.find((b) => b.denom === asset.asset.base) || { amount: '0' }
      const balanceInMicro = shiftDigits(balance.amount, -asset.asset.decimal || -18).toNumber()
      const combinBalance = num(balanceInMicro || 0)
        .plus(position?.amount || 0)
        .toNumber()
      console.log("combinBalance", combinBalance, balanceInMicro, position?.amount)
      const price = prices?.find((p) => p.denom === asset.asset.base)?.price || 0
      const walletsdValue = num(balanceInMicro).times(price).toNumber()
      const depositUsdValue = num(position?.usdValue || 0).toNumber()
      const combinUsdValue = num(combinBalance).times(price).toNumber()

      if (asset.supplyCapRatio === '0' && (position?.amount === undefined || position?.amount === 0)) return {
        ...asset.asset,
        walletBalance: Number(balanceInMicro),
        walletsdValue: 0,
        deposited: position?.amount || 0,
        depositUsdValue: 0,
        combinBalance: 0,
        combinUsdValue: 0,
        price,
      }

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
  }, [balances, basketPositions, basket, prices, positionIndex, basketAssets, chainName])
}

export default useCombinBalance
