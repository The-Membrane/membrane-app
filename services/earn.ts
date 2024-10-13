
import contracts from '@/config/contracts.json'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient' 
import { EarnQueryClient } from '@/contracts/codegen/earn/Earn.client'
import { APRResponse, newAPRResponse } from '@/contracts/codegen/earn/Earn.types'
import { Basket, BasketPositionsResponse, CollateralInterestResponse, Uint128 } from '@/contracts/codegen/positions/Positions.types'
import { useQueries } from '@tanstack/react-query'
import { getAssetRatio, getBasketAssets, getDebt, getPositions, getRateCost, getTVL, getUserDiscount } from './cdp'
import { useBasket, useBasketPositions, useCollateralInterest } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import { shiftDigits } from '@/helpers/math'
import { num } from '@/helpers/num'
import { Price } from './oracle'

export const EarnClient = async () => {
  const cosmWasmClient = await getCosmWasmClient()
  return new EarnQueryClient(cosmWasmClient, contracts.earn)
}
// export const usdcVaultClient = async () => {
//   return new EarnQueryClient(cosmWasmClient, contracts.earn)
// }

export const getUnderlyingUSDC = async (vtAmount: string) => {
  const client = await EarnClient()
  return client.vaultTokenUnderlying({ vaultTokenAmount: vtAmount}).then((res) => res) as Promise<Uint128>    
}


export const getVaultAPRResponse = async () => {
  const cosmWasmClient = await getCosmWasmClient()  
  return cosmWasmClient.queryContractSmart(contracts.marsUSDCvault, {
    a_p_r: {}
  }) as Promise<APRResponse>   
}

export const getEarnUSDCRealizedAPR = async () => {
  const client = await EarnClient()
  return client.aPR().then((res) => res) as Promise<newAPRResponse> 
}

export const getEstimatedAnnualInterest = (basketPositions: BasketPositionsResponse[], prices: Price[], basket: Basket, interest: CollateralInterestResponse, userDiscountQueries: any[]) => {
  var totalExpectedRevenue = 0
  var undiscountedTER = 0
  //  

  console.log("above map", basketPositions)
  basketPositions?.map((basketPosition, index) => {
  console.log("in map", basketPosition)
    const positions = getPositions([basketPosition], prices)
    const tvl = getTVL(positions)
    const basketAssets = getBasketAssets(basket, interest)
    const debt = getDebt([basketPosition])
    const positionsWithRatio = getAssetRatio(false, tvl, positions)

    console.log("above discount")
    const discountRatio = (userDiscountQueries.length !== 0 && userDiscountQueries[index].data) ? userDiscountQueries[index].data.discount : "0"
    console.log("discount", discountRatio)
    const cost = getRateCost(positions, tvl, basketAssets, positionsWithRatio).cost
    const discountedCost = cost * (num(1).minus(discountRatio)).toNumber()
    const annualInterest = !Number.isNaN(cost) ? cost * shiftDigits(debt, 6).toNumber() : 0
    const discountedAnnualInterest = !Number.isNaN(discountedCost) ? discountedCost * shiftDigits(debt, 6).toNumber() : 0
    console.log("annualInterest", annualInterest, "discountedAnnualInterest", discountedAnnualInterest)
    totalExpectedRevenue += discountedAnnualInterest
    undiscountedTER += annualInterest
  })

  return { totalExpectedRevenue, undiscountedTER }
  
}

