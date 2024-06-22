import contracts from '@/config/contracts.json'
import { PositionsQueryClient } from '@/contracts/codegen/positions/Positions.client'
import {
  Addr,
  Basket,
  BasketPositionsResponse,
  CollateralInterestResponse,
} from '@/contracts/codegen/positions/Positions.types'
import { Asset, getAssetByDenom, getChainAssets } from '@/helpers/chain'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient'
import { shiftDigits } from '@/helpers/math'
import { Price } from './oracle'
import { num } from '@/helpers/num'
import { useBasket, useCollateralInterest } from '@/hooks/useCDP'
import { stableSymbols } from '@/config/defaults'

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

export const getUserPositions = async (address: Addr) => {
  const client = await cdpClient()
  return client.getBasketPositions({
    user: address,
  })
}

export const getBasketPositions = async () => {
  const client = await cdpClient()
  return client.getBasketPositions({
    limit: 1024,
  })
}

export const getDebt = (basketPositions: BasketPositionsResponse[] | undefined, positionIndex: number = 0) => {
  if (!basketPositions) return 0
  const debt = basketPositions?.[0]?.positions?.[positionIndex]?.credit_amount
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
    if (!position) return acc
    return acc + position.usdValue
  }, 0)
}

export interface Prices {
  [key: string]: number
}

export const getPositions = (basketPositions?: BasketPositionsResponse[], prices?: Price[], positionIndex: number = 0) => {
  //This allows us to create a new position for users even if they have open positions
  if (basketPositions && positionIndex === basketPositions[0].positions.length) return []
  if (!basketPositions) return []
  const positions = basketPositions?.[0]?.positions?.[positionIndex]

  return positions?.collateral_assets.map((asset) => {
    const denom = asset.asset.info.native_token.denom
    const assetInfo = getAssetByDenom(denom)
    const amount = shiftDigits(asset.asset.amount, -(assetInfo?.decimal??6)).toNumber()
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

export const getAssetRatio = (skipStable: boolean, tvl: number, positions: Positions[]) => {
  if (!positions) return []
  return positions.map((position) => {
    if (!position || (skipStable && stableSymbols.includes(position.symbol))) return
    if (skipStable && positions.length === 2) return {
      ...position,
      ratio: 1,
    }

    return {
      ...position,
      ratio: num(position.usdValue).div(tvl).toNumber(),
    }
  })
}

export const getRateCost = (
  positions: Positions[],
  tvl: number,
  basketAssets: BasketAsset[] = [],
): { cost: number, ratios: any } => {
  if (!positions) return {cost: 0, ratios: []}
  const positionsWithRatio = getAssetRatio(false, tvl, positions)
  const cost = positionsWithRatio.reduce((acc, position) => {    
    if (!position) return acc
    const rate =
      basketAssets.find((asset) => asset?.asset?.base === position.denom)?.interestRate || 0
    return acc.plus(num(position.ratio).times(rate))
  }, num(0))

  return {cost: cost.toNumber(), ratios: positionsWithRatio}
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
  const positionsWithRatio = ratios??getAssetRatio(false, tvl, positions);
  const maxBorrowLTV = positionsWithRatio.reduce((acc, position) => { 
    if (!position) return acc
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
  const positionsWithRatio = ratios??getAssetRatio(false, tvl, positions);

  const maxLTV = positionsWithRatio.reduce((acc, position) => { 
    if (!position) return acc
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
  ltv: number
}
export const getMintAmount = ({
  tvl,
  creditPrice,
  debtAmount,
  ltv,
}: MaxMint) => {
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
  positionIndex: number
  prices?: Price[]
  newDeposit: number
  summary?: any[]
  mint?: number
  repay?: number
  newDebtAmount?: number
  initialBorrowLTV: number
  initialLTV: number
  initialTVL: number
  debtAmount: number
  basketAssets: BasketAsset[]
}

export const updatedSummary = (summary: any, basketPositions: any, prices: any, positionIndex: number = 0) => {

  //If no initial position, return a summary using the summary from the mint state
  if (!basketPositions){
    console.log("bp")

    return summary.map((position) => {
      if (!position) return
      const price = prices?.find((p) => p.denom === (position.base))?.price || 0
      const amount = num(position?.amount).toNumber()
      const usdValue = amount * price
      return {
        ...position,
        amount,
        usdValue,
      }
    })
  }
  console.log("positions again:", basketPositions, positionIndex)

  const positions = getPositions(basketPositions, prices, positionIndex)
  console.log("positions.map")

  return positions.map((position) => {
    if (!position) return
  console.log("updatedPosition")
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
  positionIndex = 0,
  prices,
  newDeposit,
  summary = [],
  mint = 0,
  repay = 0,
  newDebtAmount = 0,
  initialBorrowLTV,
  initialLTV,
  initialTVL,
  debtAmount,
  basketAssets,
}: VaultSummary) => {
  console.log("vault sum", positionIndex)
  if (!basket || !collateralInterest || (!basketPositions && summary.length === 0) || !prices) {
    console.log("early return")
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
  console.log("pre-sum")

  const positions = updatedSummary(summary, basketPositions, prices, positionIndex)
  console.log("positions: ", positions)
  if (!positions) return {
    debtAmount: 0,
    cost: 0,
    tvl: 0,
    ltv: 0,
    borrowLTV: 0,
    liquidValue: 0,
    liqudationLTV: 0,
  }
  const tvl = initialTVL + newDeposit
  const { cost, ratios} = getRateCost(positions, tvl, basketAssets)
  const ltv = getLTV(tvl, num(debtAmount).plus(mint).minus(repay).multipliedBy(basket.credit_price.price).toNumber())

  const creditPrice = Number(basket?.credit_price.price) || 1
  const liqudationLTV = getLiqudationLTV(tvl, positions, basketAssets, ratios)
  const borrowLTV = getBorrowLTV(tvl, positions, basketAssets, ratios)
  console.log("borrowLTV", borrowLTV, tvl, positions, ratios)
  const maxMint = getMaxMint(tvl, borrowLTV, creditPrice)
  

  const mintAmount = getMintAmount({
    tvl,
    creditPrice,
    debtAmount,
    ltv: borrowLTV,
  })

  const liquidValue = getLiquidValue({
    liqudationLTV,
    debtAmount,
    mintAmount,
    repayAmount: 0,
    creditPrice,
  })

  return {
    newDebtAmount,
    debtAmount,
    cost,
    tvl,
    ltv,
    borrowLTV,
    maxMint,
    liquidValue,
    liqudationLTV,
    initialLTV,
    initialTVL,
    initialBorrowLTV,
    mintAmount,
  }
}

export const getProjectTVL = ({ basket, prices }: { basket?: Basket; prices?: Price[] }) => {
  if (!basket || !prices) return 0
  const positions = basket?.collateral_types.map((asset) => {
    const denom = asset.asset?.info.native_token?.denom
    const assetInfo = getAssetByDenom(denom)
    const amount = shiftDigits(asset.asset.amount, -(assetInfo?.decimal??6)).toNumber()
    const assetPrice = prices?.find((price) => price.denom === denom)?.price || 0

    const usdValue = num(amount).times(assetPrice).toNumber()
    return usdValue
  })

  return positions.reduce((acc, position) => { 
    if (!position) return acc
    return acc + position
  }, 0)
}

export const getRiskyPositions = (basketPositions?: BasketPositionsResponse[], prices?: Price[], basket?: Basket, interest?: CollateralInterestResponse ) => {

  if (!basketPositions || !prices || !basket || !interest) return []

  //Get current LTV & liquidation LTV for all positions
  //Return positions that can be liquidated
  return basketPositions?.map((basketPosition) => {
    const positions = getPositions([basketPosition], prices)
    const tvl = getTVL(positions)
    const debt = getDebt([basketPosition])
    const debtValue = num(debt).times(basket.credit_price.price).toNumber()
    const ltv = getLTV(tvl, debtValue)
    const positionsWithRatio = getAssetRatio(false, tvl, positions)
    const liquidationLTV = getLiqudationLTV(
      tvl,
      positions,
      getBasketAssets(basket!, interest!),
      positionsWithRatio,
    )

    if (ltv > liquidationLTV) {
      let ltv_diff = num(ltv).minus(liquidationLTV)
      let liq_ratio = ltv_diff.div(ltv)
      let liq_debt = liq_ratio.times(debtValue)
      return {
        address: basketPosition.user,
        id: basketPosition.positions[0].position_id,
        fee: ltv_diff.div(100).multipliedBy(liq_debt).toNumber().toFixed(2),
      }
    }
  })
}