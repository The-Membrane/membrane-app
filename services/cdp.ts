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

export const getDebt = (basketPositions: BasketPositionsResponse[] | undefined) => {
  if (!basketPositions) return 0
  const debt = basketPositions?.[0]?.positions?.[0]?.credit_amount
  return shiftDigits(debt, -6).toNumber()
}

export type Positions = Asset & {
  amount: number
  usdValue: number
  denom: string
}

export const getTVL = (positions: Positions[]) => {
  if (!positions) return 0
  return positions?.reduce((acc, position) => {
    return acc + position.usdValue
  }, 0)
}

export interface Prices {
  [key: string]: number
}

export const getPositions = (basketPositions?: BasketPositionsResponse[], prices?: Price[]) => {
  if (!basketPositions) return []
  const positions = basketPositions?.[0]?.positions?.[0]

  return positions?.collateral_assets.map((asset) => {
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
  }) as Positions[]
}

export const getAssetRatio = (tvl: number, positions: Positions[]) => {
  return positions.map((position) => ({
    ...position,
    ratio: num(position.usdValue).div(tvl).toNumber(),
  }))
}

export const getRateCost = (
  positions: Positions[],
  tvl: number,
  basketAssets: BasketAsset[] = [],
): number => {
  const positionsWithRatio = getAssetRatio(tvl, positions)
  const cost = positionsWithRatio.reduce((acc, position) => {
    const rate =
      basketAssets.find((asset) => asset?.asset?.base === position.denom)?.interestRate || 0
    return acc.plus(num(position.ratio).times(rate))
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
  liqudationLTV: number
  debtAmount: number
  mintAmount: number
  repayAmount: number
  creditPrice: number
}

export const getLiquidValue = ({
  liqudationLTV,
  debtAmount,
  mintAmount,
  repayAmount,
  creditPrice,
}: LiquidValue) => {
  return num(debtAmount)
    .plus(mintAmount)
    .minus(repayAmount)
    .times(creditPrice)
    .div(liqudationLTV / 100)
    .toNumber()
}

export const getBorrowLTV = (
  tvl: number,
  positions: Positions[],
  basketAssets: BasketAsset[] = [],
) => {
  const positionsWithRatio = getAssetRatio(tvl, positions)
  const maxBorrowLTV = positionsWithRatio.reduce((acc, position) => {
    const ltv =
      basketAssets.find((asset) => asset?.asset?.base === position.denom)?.maxBorrowLTV || 0
    return acc.plus(num(position.ratio).times(100).times(ltv))
  }, num(0))

  return maxBorrowLTV.dp(2).toNumber()
}

export const getMaxLTV = (
  tvl: number,
  positions: Positions[],
  basketAssets: BasketAsset[] = [],
) => {
  const positionsWithRatio = getAssetRatio(tvl, positions)

  const maxLTV = positionsWithRatio.reduce((acc, position) => {
    const ltv = basketAssets.find((asset) => asset?.asset?.base === position.denom)?.maxLTV || 0
    return acc.plus(num(position.ratio).times(100).times(ltv))
  }, num(0))

  return maxLTV.toNumber()
}

export const getLiqudationLTV = (
  tvl: number,
  positions: Positions[],
  basketAssets: BasketAsset[] = [],
) => {
  const positionsWithRatio = getAssetRatio(tvl, positions)

  const maxLTV = positionsWithRatio.reduce((acc, position) => {
    const ltv = basketAssets.find((asset) => asset?.asset?.base === position.denom)?.maxLTV || 0
    return acc.plus(num(position.ratio).times(100).times(ltv))
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
  positions: Positions[]
  basketAssets: BasketAsset[]
}
export const getMintAmount = ({
  tvl,
  creditPrice,
  debtAmount,
  positions,
  basketAssets,
}: MaxMint) => {
  const ltv = getBorrowLTV(tvl, positions, basketAssets)

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

const updatedSummary = (summary: any, basketPositions: any, prices: any) => {
  const positions = getPositions(basketPositions, prices)

  return positions.map((position) => {
    const updatedPosition = summary.find((p: any) => p.symbol === position.symbol)
    const price = prices?.find((p) => p.denom === position.denom)?.price || 0
    const amount = num(position.amount)
      .plus(updatedPosition?.amount || 0)
      .toNumber()
    const usdValue = amount * price
    return {
      ...position,
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

  const positions = updatedSummary(summary, basketPositions, prices)
  const initialPositions = getPositions(basketPositions, prices)
  const debtAmount = getDebt(basketPositions)
  // const debtAmount = 50
  const basketAssets = getBasketAssets(basket!, collateralInterest!)
  const initialTVL = getTVL(initialPositions)
  const tvl = initialTVL + newDeposit
  const cost = getRateCost(positions, tvl, basketAssets)
  const ltv = getLTV(tvl, num(debtAmount).plus(mint).minus(repay).toNumber())

  const initialLTV = getLTV(initialTVL, debtAmount)
  const creditPrice = Number(basket?.credit_price.price) || 1
  const liqudationLTV = getLiqudationLTV(tvl, positions, basketAssets)
  const borrowLTV = getBorrowLTV(tvl, positions, basketAssets)
  const initialBorrowLTV = getBorrowLTV(initialTVL, initialPositions, basketAssets)

  const mintAmount = getMintAmount({
    tvl,
    creditPrice,
    debtAmount,
    positions,
    basketAssets,
  })

  const liquidValue = getLiquidValue({
    liqudationLTV,
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
    liqudationLTV,
    initialLTV,
    initialTVL,
    initialBorrowLTV,
    mintAmount,
  }
}
