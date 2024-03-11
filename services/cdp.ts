import contracts from '@/config/contracts.json'
import { PositionsQueryClient } from '@/contracts/codegen/positions/Positions.client'
import {
  Addr,
  Basket,
  BasketPositionsResponse,
  CollateralInterestResponse,
} from '@/contracts/codegen/positions/Positions.types'
import { Asset, getAssetByDenom, getChainAssets } from '@/helpers/chain'
import getCosmWasmClient from '@/helpers/comswasmClient'
import { shiftDigits } from '@/helpers/math'
import { Price } from './oracle'
import { num } from '@/helpers/num'
import { use } from 'react'
import useMintState from '@/components/Mint/hooks/useMintState'

export const cdpClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new PositionsQueryClient(cosmWasmClient, contracts.cdp)
}

export const getBasket = async () => {
  const client = await cdpClient()
  return client.getBasket()
}

const getAsseInterestRate = (
  denom: string | undefined,
  collateralInterest: CollateralInterestResponse,
  basket: Basket,
) => {
  if (!denom || !collateralInterest || !basket) return null
  const rateIndex = basket?.collateral_types.findIndex(
    ({ asset }) => asset.info.native_token.denom === denom,
  )
  return rateIndex !== -1 ? collateralInterest?.rates[rateIndex] || 0 : null
}

export type BasketAsset = {
  asset: Asset
  interestRate: number
  rateIndex: number
  maxLTV: number
  maxBorrowLTV: number
}
export const getBasketAssets = (
  baseket: Basket,
  collateralInterest: CollateralInterestResponse,
) => {
  const chainAssets = getChainAssets()

  return baseket?.collateral_types.map((asset) => {
    const denom = asset.asset?.info.native_token?.denom
    let assetInfo = chainAssets?.find((chainAsset) => chainAsset.base === denom)

    if (!assetInfo) {
      assetInfo = {
        base: denom,
      }
    }

    const interestRate = getAsseInterestRate(assetInfo?.base, collateralInterest, baseket)
    const rateIndex = Number(asset.rate_index)
    const maxLTV = Number(asset.max_LTV)
    const maxBorrowLTV = Number(asset.max_borrow_LTV)

    return {
      asset: assetInfo,
      interestRate,
      rateIndex,
      maxLTV,
      maxBorrowLTV,
    }
  }) as BasketAsset[]
}

export const getCollateralInterest = async () => {
  const client = await cdpClient()
  return client.getCollateralInterest()
}

export const getCreditRate = async () => {
  const client = await cdpClient()
  return client.getCreditRate()
}

export const getBasketPositions = async (address: Addr) => {
  const client = await cdpClient()
  return client.getBasketPositions({
    user: address,
  })
}

export const getDebt = (basketPositions: BasketPositionsResponse[] | undefined, index: number) => {
  if (!basketPositions) return 0
  const debt = basketPositions?.[0]?.positions?.[index]?.credit_amount
  return shiftDigits(debt, -6).toNumber()
}

export type PositionAsset = Asset & {
  amount: number
  usdValue: number
  denom: string
}

export const getTVL = (positionAssets: PositionAsset[]) => {
  if (!positionAssets) return 0
  return positionAssets?.reduce((acc, asset) => {
    return acc + asset.usdValue
  }, 0)
}

export interface Prices {
  [key: string]: number
}

export const getPositionAssets = (index: number, basketPositions?: BasketPositionsResponse[], prices?: Price[]) => {
  if (!basketPositions) return []
  const position = basketPositions?.[0]?.positions?.[index]

  return position?.collateral_assets.map((asset) => {
    const denom = asset.asset.info.native_token.denom
    const assetInfo = getAssetByDenom(denom) || { denom }
    const amount = shiftDigits(asset.asset.amount, -6).toNumber()
    const assetPrice = prices?.find((price) => price.denom === denom)?.price || 0

    const usdValue = num(amount).times(assetPrice).toNumber()
    return {
      ...assetInfo,
      denom,
      amount,
      usdValue,
    }
  }) as PositionAsset[]
}

export const getAssetRatio = (tvl: number, positionAssets: PositionAsset[]) => {
  return positionAssets.map((asset) => ({
    ...asset,
    ratio: num(asset.usdValue).div(tvl).toNumber(),
  }))
}

export const getRateCost = (
  positionAssets: PositionAsset[],
  tvl: number,
  basketAssets: BasketAsset[] = [],
): number => {
  const assetswithRatio = getAssetRatio(tvl, positionAssets)
  const cost = assetswithRatio.reduce((acc, asset) => {
    const rate = basketAssets.find((basket_asset) => basket_asset?.asset?.base === asset.denom)?.interestRate || 0

    return acc.plus(num(asset.ratio).times(rate))
  }, num(0))

  return cost.toNumber()
}

export type LiquidationLTV = {
  tvl: number
  debtAmount: number
  mintAmount?: number
  repayAmount?: number
  creditPrice: number
}
//currentLTV
export const getLquidationLTV = ({
  tvl,
  debtAmount,
  mintAmount = 0,
  repayAmount = 0,
  creditPrice,
}: LiquidationLTV) => {
  return num(debtAmount)
    .plus(mintAmount)
    .minus(repayAmount)
    .times(creditPrice)
    .div(tvl)
    .times(100)
    .toNumber()
}

export type LiquidValue = {
  liquidationLTV: number
  debtAmount: number
  mintAmount: number
  repayAmount: number
  creditPrice: number
}

export const getLiquidValue = ({
  liquidationLTV,
  debtAmount,
  mintAmount,
  repayAmount,
  creditPrice,
}: LiquidValue) => {
  return num(debtAmount)
    .plus(mintAmount)
    .minus(repayAmount)
    .times(creditPrice)
    .div(liquidationLTV / 100)
    .toNumber()
}

export const getBorrowLTV = (
  tvl: number,
  positionAssets: PositionAsset[],
  basketAssets: BasketAsset[] = [],
) => {
  const assetswithRatio = getAssetRatio(tvl, positionAssets)
  const maxBorrowLTV = assetswithRatio.reduce((acc, asset) => {
    const ltv =
      basketAssets.find((basket_asset) => basket_asset?.asset?.base === asset.denom)?.maxBorrowLTV || 0
    return acc.plus(num(asset.ratio).times(100).times(ltv))
  }, num(0))

  return maxBorrowLTV.dp(2).toNumber()
}

export const getMaxLTV = (
  tvl: number,
  positionAssets: PositionAsset[],
  basketAssets: BasketAsset[] = [],
) => {
  const assetswithRatio = getAssetRatio(tvl, positionAssets)

  const maxLTV = assetswithRatio.reduce((acc, asset) => {
    const ltv = basketAssets.find((basket_asset) => basket_asset?.asset?.base === asset.denom)?.maxLTV || 0
    return acc.plus(num(asset.ratio).times(100).times(ltv))
  }, num(0))

  return maxLTV.toNumber()
}

export const getLTV = (tvl: number, debtAmount: number) => {
  if (num(debtAmount).isZero()) return 0
  return num(debtAmount).dividedBy(tvl).times(100).dp(2).toNumber()
}

export type MaxMint = {
  tvl: number
  creditPrice: number
  debtAmount: number
  positionAssets: PositionAsset[]
  basketAssets: BasketAsset[]
}
export const getMintAmount = ({
  tvl,
  creditPrice,
  debtAmount,
  positionAssets,
  basketAssets,
}: MaxMint) => {
  const ltv = getBorrowLTV(tvl, positionAssets, basketAssets)

  const creditPriceAdjusted = Math.max(creditPrice, 1)
  return num(tvl)
    .times(ltv / 100)
    .dividedBy(creditPriceAdjusted)
    .minus(debtAmount)
    .toNumber()
}

type VaultSummary = {
  basket?: Basket
  collateralInterest?: CollateralInterestResponse
  basketPositions?: BasketPositionsResponse[]
  prices?: Price[]
  newDeposit: number
  summary?: any[]
  mint?: number
  repay?: number
}

const updatedSummary = (summary: any, basketPositions: any, prices: any, index: number) => {
  const positionAssets = getPositionAssets(index, basketPositions, prices)

  return positionAssets.map((asset) => {
    const updatedPosition = summary.find((p: any) => p.symbol === asset.symbol)
    const price = prices?.find((p) => p.denom === asset.denom)?.price || 0
    const amount = num(asset.amount)
      .plus(updatedPosition?.amount || 0)
      .toNumber()
    const usdValue = amount * price
    return {
      ...asset,
      amount,
      usdValue,
    }
  })
}

export const calculateVaultSummary = ({
  basket,
  collateralInterest,
  basketPositions,
  prices,
  newDeposit,
  summary = [],
  mint = 0,
  repay = 0,
}: VaultSummary) => {
  if (!basket || !collateralInterest || !basketPositions || !prices) {
    return {
      debtAmount: 0,
      cost: 0,
      tvl: 0,
      ltv: 0,
      borrowLTV: 0,
      liquidValue: 0,
      liqudationLTV: 0,
    }
  }
  const { mintState } = useMintState()
  const positionAssets = updatedSummary(mintState.index, summary, basketPositions, prices)
  const initialpositionAssets = getPositionAssets(mintState.index, basketPositions, prices)
  const debtAmount = getDebt(basketPositions, mintState.index)
  // const debtAmount = 50
  const basketAssets = getBasketAssets(basket!, collateralInterest!)
  const initialTVL = getTVL(initialpositionAssets)
  const tvl = initialTVL + newDeposit
  const cost = getRateCost(positionAssets, tvl, basketAssets)
  const ltv = getLTV(tvl, num(debtAmount).plus(mint).minus(repay).toNumber())

  const initialLTV = getLTV(initialTVL, debtAmount)
  const creditPrice = Number(basket?.credit_price.price) || 1
  const liquidationLTV = getMaxLTV(tvl, positionAssets, basketAssets)
  const borrowLTV = getBorrowLTV(tvl, positionAssets, basketAssets)
  const initialBorrowLTV = getBorrowLTV(initialTVL, initialpositionAssets, basketAssets)

  const mintAmount = getMintAmount({
    tvl,
    creditPrice,
    debtAmount,
    positionAssets,
    basketAssets,
  })

  const liquidValue = getLiquidValue({
    liquidationLTV,
    debtAmount,
    mintAmount,
    repayAmount: 0,
    creditPrice,
  })

  return {
    debtAmount,
    cost,
    tvl,
    ltv,
    borrowLTV,
    liquidValue,
    liquidationLTV,
    initialLTV,
    initialTVL,
    initialBorrowLTV,
    mintAmount,
  }
}
