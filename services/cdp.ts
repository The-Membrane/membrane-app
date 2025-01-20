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
import { stableSymbols } from '@/config/defaults'
import { useOraclePrice } from '@/hooks/useOracle'
import { useUserDiscount } from '@/hooks/useCDP'
import { useQueries } from '@tanstack/react-query'

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
    //@ts-ignore
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
  supplyCapRatio: string
  SPCapRatio?: string
}
export const getBasketAssets = (
  basket: Basket,
  collateralInterest: CollateralInterestResponse,
) => {
  const chainAssets = getChainAssets()

  return basket?.collateral_types.map((asset, index) => {
    //@ts-ignore
    const denom = asset.asset?.info.native_token?.denom
    let assetInfo = chainAssets?.find((chainAsset) => chainAsset.base === denom)

    if (!assetInfo) {
      //@ts-ignore
      assetInfo = {
        base: denom,
      }
    }

    const interestRate = getAsseInterestRate(assetInfo?.base, collateralInterest, basket)
    const rateIndex = Number(asset.rate_index)
    const maxLTV = Number(asset.max_LTV)
    const maxBorrowLTV = Number(asset.max_borrow_LTV)

    return {
      asset: assetInfo,
      interestRate,
      rateIndex,
      maxLTV,
      maxBorrowLTV,
      supplyCapRatio: basket?.collateral_supply_caps[index].supply_cap_ratio,
      SPCapRatio: basket?.collateral_supply_caps[index].stability_pool_ratio_for_debt_cap
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

export const getUserDiscount = async (address: string) => {
  const cosmWasmClient = await getCosmWasmClient()
  return cosmWasmClient.queryContractSmart(contracts.system_discounts, {
    user_discount: { user: address }
  }) as Promise<{ user: string, discount: string }>
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
    //@ts-ignore
    const denom = asset.asset.info.native_token.denom
    const assetInfo = getAssetByDenom(denom)
    const amount = shiftDigits(asset.asset.amount, -(assetInfo?.decimal ?? 6)).toNumber()
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
  positionRatios?: any[],
): { cost: number, ratios: any, costRatios: any } => {
  //@ts-ignore
  var costRatios = []
  //@ts-ignore
  if (!positions) return { cost: 0, ratios: [], costRatios }
  const positionsWithRatio = positionRatios ? positionRatios : getAssetRatio(false, tvl, positions)
  const cost = positionsWithRatio.reduce((acc, position) => {
    if (!position) return acc
    //Get the interest rate for the asset
    const rate =
      basketAssets.find((asset) => asset?.asset?.base === position.base)?.interestRate || 0
    //Add to costRatios
    costRatios.push({ symbol: position.symbol, denom: position.base, ratio: num(position.ratio).times(100).toNumber(), rate: rate })
    //Return the proportional cost of the collateral
    return acc.plus(num(position.ratio).times(rate))
  }, num(0))

  //@ts-ignore
  return { cost: cost.toNumber(), ratios: positionsWithRatio, costRatios }
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
  const positionsWithRatio = ratios ?? getAssetRatio(false, tvl, positions);
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
  const positionsWithRatio = ratios ?? getAssetRatio(false, tvl, positions);

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
  discount: string
}

export const updatedSummary = (summary: any, basketPositions: any, prices: any, positionIndex: number = 0) => {

  //If no initial position, return a summary using the summary from the mint state
  if (!basketPositions) {

    //@ts-ignore
    return summary.map((position) => {
      if (!position) return
      //@ts-ignore
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

  const positions = getPositions(basketPositions, prices, positionIndex)

  return positions.map((position) => {
    if (!position) return
    const updatedPosition = summary.find((p: any) => p.symbol === position.symbol)
    //@ts-ignore
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
  discount,
}: VaultSummary) => {
  if (!basket || !collateralInterest || (!basketPositions && summary.length === 0) || !prices) {
    {
      console.log("returning 0 debt")
      return {
        debtAmount,
        cost: 0,
        tvl: initialTVL,
        ltv: initialLTV,
        borrowLTV: initialBorrowLTV,
        liquidValue: 0,
        liqudationLTV: 0,
        discountedCost: 0,
        newDebtAmount,
        costRatios: [],
        positionId: "0",
      }
    }
  }

  const positions = updatedSummary(summary, basketPositions, prices, positionIndex)
  if (!positions) {
    console.log("returning 0 debt 2")
    return {
      debtAmount,
      cost: 0,
      discountedCost: 0,
      tvl: initialTVL,
      ltv: initialLTV,
      borrowLTV: initialBorrowLTV,
      liquidValue: 0,
      newDebtAmount,
      liqudationLTV: 0,
      costRatios: [],
      positionId: "0",
    }
  }
  console.log("running summ")
  const tvl = initialTVL + newDeposit
  const { cost, ratios, costRatios } = getRateCost(positions, tvl, basketAssets)
  const ltv = getLTV(tvl, num(debtAmount).plus(mint).minus(repay).multipliedBy(basket.credit_price.price).toNumber())

  const creditPrice = Number(basket?.credit_price.price) || 1
  const liqudationLTV = getLiqudationLTV(tvl, positions, basketAssets, ratios)
  const borrowLTV = getBorrowLTV(tvl, positions, basketAssets, ratios)
  const maxMint = getMaxMint(tvl, borrowLTV, creditPrice)


  const remainingMintAmount = getMintAmount({
    tvl,
    creditPrice,
    debtAmount,
    ltv: borrowLTV,
  })

  const liquidValue = getLiquidValue({
    liqudationLTV,
    debtAmount,
    mintAmount: mint,
    repayAmount: repay,
    creditPrice,
  })

  return {
    newDebtAmount,
    debtAmount,
    cost,
    discountedCost: cost * (num(1).minus(discount)).toNumber(),
    costRatios,
    tvl,
    ltv,
    borrowLTV,
    maxMint,
    liquidValue,
    liqudationLTV,
    initialLTV,
    initialTVL,
    initialBorrowLTV,
    remainingMintAmount,
    positionId: basketPositions?.[0]?.positions?.[positionIndex]?.position_id ?? "0",
  }
}

export const getProjectTVL = ({ basket, prices }: { basket?: Basket; prices?: Price[] }) => {
  if (!basket || !prices) return 0
  const positions = basket?.collateral_types.map((asset) => {
    //@ts-ignore
    const denom = asset.asset?.info.native_token?.denom
    const assetInfo = getAssetByDenom(denom)
    // console.log(assetInfo, denom, asset.asset)
    const amount = shiftDigits(asset.asset.amount, -(assetInfo?.decimal ?? 6)).toNumber()
    const assetPrice = prices?.find((price) => price.denom === denom)?.price || 0

    const usdValue = num(amount).times(assetPrice).toNumber()
    // console.log(assetInfo?.symbol, usdValue, amount, assetPrice)
    return usdValue
  })

  return positions.reduce((acc, position) => {
    if (!position) return acc
    return acc + position
  }, 0)
}

export const getRiskyPositions = (basketPositions: BasketPositionsResponse[], prices: Price[], basket: Basket, interest: CollateralInterestResponse) => {

  // if (!basketPositions || !prices || !basket || !interest) return { liquidatibleCDPs: [], totalExpectedRevenue: 0, undiscountedTER: 0 }


  // const bundles: string[][] = []
  // const tally: number[] = []
  // const totalValue: number[] = []

  // console.log("user discount", getUserDiscountValue("osmo1fd8z9npe5gd6afm0wj60tryzx04gn5jl84hcm2"))

  // console.log("basketPositions", basketPositions)

  var liquidatibleCDPs: any[] = []

  //Get current LTV & liquidation LTV for all positions
  //Return positions that can be liquidated
  {
    basketPositions?.map((basketPosition, index) => {
      //check every position index
      if (basketPosition && basketPosition.positions.length > 0) {

        basketPosition.positions.forEach((position, index) => {

          const positions = getPositions([basketPosition], prices, index)


          // Create a list of the position's assets and sort alphabetically
          // const assetList = positions.map((position) => position.symbol).sort()
          // // If the asset list is already in the bundles, increment the tally array of the same index & add the total value of the position to the totalValue array
          // // Otherwise, add the asset list to the bundles, add 1 to the tally & add the total value of the position to the totalValue array
          // const index = bundles.findIndex((bundle) => bundle.join('') === assetList.join(''))
          // if (index !== -1) {
          //   tally[index] += 1
          //   totalValue[index] += positions.reduce((acc, position) => { 
          //     if (!position) return acc
          //     return acc + position.usdValue
          //   }, 0)
          // } else {
          //   bundles.push(assetList)
          //   tally.push(1)
          //   totalValue.push(positions.reduce((acc, position) => { 
          //     if (!position) return acc
          //     return acc + position.usdValue
          //   }, 0))
          // }

          // //Log the top 5 most common asset bundles
          // const topBundles = tally.map((count, i) => {
          //   return { bundle: bundles[i], count }
          // }).sort((a, b) => b.count - a.count)//.slice(0, 5)
          // console.log(topBundles)
          // //Log the highest value bundles
          // const topValue = totalValue.map((value, i) => {
          //   return { bundle: bundles[i], value }
          // }).sort((a, b) => b.value - a.value)//.slice(0, 5)
          // console.log(topValue)

          const tvl = getTVL(positions)
          const debt = getDebt([basketPosition])
          //skip if no debt
          if (debt === 0) { console.log("no debt"); return undefined }
          ////////////////////////////////
          const debtValue = num(debt).times(basket.credit_price.price).toNumber()
          if (debtValue === 0) { console.log("no debt"); return undefined }
          const ltv = getLTV(tvl, debtValue)
          const positionsWithRatio = getAssetRatio(false, tvl, positions)
          const basketAssets = getBasketAssets(basket!, interest!)
          const liquidationLTV = getLiqudationLTV(
            tvl,
            positions,
            basketAssets,
            positionsWithRatio,
          )

          // const discountRatio = userDiscountQueries[index].data ? userDiscountQueries[index].data.discount : "0"
          // if (getRevenue){
          //   console.log("discount", discountRatio)
          //   const cost = getRateCost(positions, tvl, basketAssets, positionsWithRatio).cost
          //   const discountedCost = cost * (num(1).minus(discountRatio)).toNumber()
          //   const annualInterest = !Number.isNaN(cost) ? cost * shiftDigits(debt, 6).toNumber() : 0
          //   const discountedAnnualInterest = !Number.isNaN(discountedCost) ? discountedCost * shiftDigits(debt, 6).toNumber() : 0
          //   console.log("annualInterest", annualInterest, "discountedAnnualInterest", discountedAnnualInterest)
          //   totalExpectedRevenue += discountedAnnualInterest
          //   undiscountedTER += annualInterest
          // }

          console.log(ltv, "<", liquidationLTV)
          if (ltv > liquidationLTV) {
            let ltv_diff = num(ltv).minus(liquidationLTV)
            let liq_ratio = ltv_diff.div(ltv)
            let liq_debt = liq_ratio.times(debtValue)
            liquidatibleCDPs.push({
              address: basketPosition.user,
              id: basketPosition.positions[0].position_id,
              fee: ltv_diff.div(100).multipliedBy(liq_debt).toNumber().toFixed(2),
            })
          }
        })

      }
    })
  }

  return { liquidatibleCDPs }
}