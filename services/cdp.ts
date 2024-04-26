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
): { cost: number, ratios: any } => {
  const positionsWithRatio = getAssetRatio(tvl, positions)
  const cost = positionsWithRatio.reduce((acc, position) => {
    const rate =
      basketAssets.find((asset) => asset?.asset?.base === position.denom)?.interestRate || 0
    return acc.plus(num(position.ratio).times(rate))
  }, num(0))

  return {cost: cost.toNumber(), ratios: positionsWithRatio}
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
  ratios?: any[],
) => {  
  const positionsWithRatio = ratios??getAssetRatio(tvl, positions);
  const maxBorrowLTV = positionsWithRatio.reduce((acc, position) => {
    const ltv =
      basketAssets.find((asset) => asset?.asset?.base === position.denom || asset?.asset?.base === position.base)?.maxBorrowLTV || 0
    return acc.plus(num(position.ratio).times(100).times(ltv))
  }, num(0))

  return maxBorrowLTV.dp(2).toNumber()
}

//Max debt to mint
export const getMaxMint = (
  tvl: number,
  borrowLTV: number,
  creditPrice: number,
) => {
  return num(tvl).times(borrowLTV / 100).dividedBy(creditPrice).toNumber()
}

export const getLiqudationLTV = (
  tvl: number,
  positions: Positions[],
  basketAssets: BasketAsset[] = [],
  ratios?: any[],
) => {
  const positionsWithRatio = ratios??getAssetRatio(tvl, positions);

  const maxLTV = positionsWithRatio.reduce((acc, position) => {
    const ltv = basketAssets.find((asset) => asset?.asset?.base === position.denom || asset?.asset?.base === position.base)?.maxLTV || 0
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
  summary?: any[]
}
export const getMintAmount = ({
  tvl,
  creditPrice,
  debtAmount,
  positions,
  basketAssets,
  summary = [],
}: MaxMint) => {
  const ltv = getBorrowLTV(tvl, positions, basketAssets, summary)

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
  newDebtAmount?: number
  initialBorrowLTV?: number
  initialLTV?: number
  initialTVL?: number
  initialPositions?: any[]
  debtAmount?: number
  basketAssets?: BasketAsset[]
}

const updatedSummary = (summary: any, basketPositions: any, prices: any) => {

  //If no initial position, return a summary using the summary from the mint state
  if (!basketPositions){

    return summary.map((position) => {
      const price = prices?.find((p) => p.denom === position.base)?.price || 0
      const amount = num(position.amount).toNumber()
      const usdValue = amount * price
      return {
        ...position,
        amount,
        usdValue,
      }
    })
  }

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
  newDebtAmount = 0,
  initialBorrowLTV,
  initialLTV,
  initialTVL,
  initialPositions,
  debtAmount,
  basketAssets,
}: VaultSummary) => {
  if (!basket || !collateralInterest || (!basketPositions && summary.length === 0) || !prices) {
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
  const calc_initialPositions = initialPositions??getPositions(basketPositions, prices)
  const calc_debtAmount = debtAmount??getDebt(basketPositions)
  const calc_basketAssets = basketAssets??getBasketAssets(basket!, collateralInterest!)
  const calc_initialTVL = initialTVL??getTVL(calc_initialPositions)
  const tvl = calc_initialTVL + newDeposit
  const { cost, ratios} = getRateCost(positions, tvl, basketAssets)
  const ltv = getLTV(tvl, num(calc_debtAmount).plus(mint).minus(repay).toNumber())


  const calc_initialLTV = initialLTV??getLTV(calc_initialTVL, calc_debtAmount)
  const creditPrice = Number(basket?.credit_price.price) || 1
  const liqudationLTV = getLiqudationLTV(tvl, positions, calc_basketAssets, ratios)
  const borrowLTV = getBorrowLTV(tvl, positions, calc_basketAssets, ratios)
  const calc_initialBorrowLTV = initialBorrowLTV??getBorrowLTV(calc_initialTVL, calc_initialPositions, calc_basketAssets)
  const maxMint = getMaxMint(tvl, borrowLTV, creditPrice)
  
  console.log(maxMint)

  const mintAmount = getMintAmount({
    tvl,
    creditPrice,
    debtAmount: calc_debtAmount,
    positions,
    basketAssets: calc_basketAssets,
    summary,
  })

  const liquidValue = getLiquidValue({
    liqudationLTV,
    debtAmount: calc_debtAmount,
    mintAmount,
    repayAmount: 0,
    creditPrice,
  })

  return {
    newDebtAmount,
    debtAmount: calc_debtAmount,
    cost,
    tvl,
    ltv,
    borrowLTV,
    maxMint,
    liquidValue,
    liqudationLTV,
    initialLTV: calc_initialLTV,
    initialTVL: calc_initialTVL,
    initialBorrowLTV: calc_initialBorrowLTV,
    mintAmount,
  }
}

export const getProjectTVL = ({ basket, prices }: { basket?: Basket; prices?: Price[] }) => {
  if (!basket || !prices) return 0
  const positions = basket?.collateral_types.map((asset) => {
    const denom = asset.asset?.info.native_token?.denom
    const amount = shiftDigits(asset.asset.amount, -6).toNumber()
    const assetPrice = prices?.find((price) => price.denom === denom)?.price || 0

    const usdValue = num(amount).times(assetPrice).toNumber()
    return usdValue
  })

  return positions.reduce((acc, position) => {
    return acc + position
  }, 0)
}
