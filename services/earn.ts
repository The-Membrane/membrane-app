
import contracts from '@/config/contracts.json'
import { getCosmWasmClient } from '@/helpers/cosmwasmClient' 
import { EarnQueryClient } from '@/contracts/codegen/earn/Earn.client'
import { APRResponse, ClaimTracker } from '@/contracts/codegen/earn/Earn.types'
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

export const getBoundedConfig = async () => {
  console.log("r u running")
  const cosmWasmClient = await getCosmWasmClient()  
  return cosmWasmClient.queryContractSmart(contracts.rangeboundLP, {
    config: { }
  }) as Promise<{
    owner: string,
    osmosis_proxy_contract_addr: string,
    oracle_contract_addr: string,
    vault_token: string,
    range_tokens: {
      ceiling_deposit_token: string,
      floor_deposit_token: string
    },
    range_bounds: {
      ceiling: {
        lower_tick: number,
        upper_tick: number
      },
      floor: {
        lower_tick: number,
        upper_tick: number
      }
    },
    range_position_ids: {
      ceiling: number,
      floor: number
    }
  }>   
}

export const getBoundedTVL = async () => {
  const cosmWasmClient = await getCosmWasmClient()  
  return cosmWasmClient.queryContractSmart(contracts.rangeboundLP, {
    total_t_v_l: { }
  }) as Promise<Uint128>   

}
export const getUnderlyingUSDC = async (vtAmount: string) => {
  const client = await EarnClient()
  return client.vaultTokenUnderlying({ vaultTokenAmount: vtAmount}).then((res) => res) as Promise<Uint128>    
}

export const getUnderlyingCDT = async (vtAmount: string) => {
  const cosmWasmClient = await getCosmWasmClient()  
  return cosmWasmClient.queryContractSmart(contracts.autoStabilityPool, {
    vault_token_underlying: {
      vault_token_amount: vtAmount
    }
  }) as Promise<Uint128>   
}

export const getBoundedUnderlyingCDT = async (vtAmount: string) => {
  const cosmWasmClient = await getCosmWasmClient()  
  return cosmWasmClient.queryContractSmart(contracts.rangeboundLP, {
    vault_token_underlying: {
      vault_token_amount: vtAmount
    }
  }) as Promise<Uint128>   
}


export const getVaultAPRResponse = async () => {
  const cosmWasmClient = await getCosmWasmClient()  
  return cosmWasmClient.queryContractSmart(contracts.marsUSDCvault, {
    a_p_r: {}
  }) as Promise<APRResponse>   
}

export const getEarnUSDCRealizedAPR = async () => {
  const client = await EarnClient()
  return client.aPR().then((res) => res) as Promise<ClaimTracker> 
}

export const getEarnCDTRealizedAPR = async () => {
  const cosmWasmClient = await getCosmWasmClient()  
  return cosmWasmClient.queryContractSmart(contracts.autoStabilityPool, {
    claim_tracker: { }
  }) as Promise<ClaimTracker> 
}

export const getBoundedCDTRealizedAPR = async () => {
  const cosmWasmClient = await getCosmWasmClient()  
  return cosmWasmClient.queryContractSmart(contracts.rangeboundLP, {
    claim_tracker: { }
  }) as Promise<ClaimTracker> 
}

export const getEstimatedAnnualInterest = (basketPositions: BasketPositionsResponse[], prices: Price[], basket: Basket, interest: CollateralInterestResponse, userDiscountQueries: any[]) => {
  var totalExpectedRevenue = 0
  var undiscountedTER = 0
  //  
// // 
    // var debtTallies = [0,0,0, 0]
//   console.log("above map", basketPositions)
  basketPositions?.map((basketPosition, index) => {
    var debt = getDebt([basketPosition])
    if (!debt || debt <= 1000 ) return
    if (basketPosition.user == contracts.earn) debt = debt * 0.75
    // debtTallies[0] += 1
  // console.log("in map", basketPosition)
    const positions = getPositions([basketPosition], prices)
    const tvl = getTVL(positions)
    const basketAssets = getBasketAssets(basket, interest)
    const positionsWithRatio = getAssetRatio(false, tvl, positions)

    // console.log("above discount")
    const discountRatio = (userDiscountQueries.length !== 0 && userDiscountQueries[index].data) ? userDiscountQueries[index].data.discount : "0"
    // console.log("discount", discountRatio)
    const cost = getRateCost(positions, tvl, basketAssets, positionsWithRatio).cost
    const discountedCost = cost * (num(1).minus(discountRatio)).toNumber()
    const annualInterest = !Number.isNaN(cost) ? cost * shiftDigits(debt, 6).toNumber() : 0
    const discountedAnnualInterest = !Number.isNaN(discountedCost) ? discountedCost * shiftDigits(debt, 6).toNumber() : 0
    // console.log("annualInterest", annualInterest, "discountedAnnualInterest", discountedAnnualInterest)
    totalExpectedRevenue += discountedAnnualInterest
    undiscountedTER += annualInterest
  })
  // console.log("debtTallies", debtTallies)

  return { totalExpectedRevenue, undiscountedTER }  
}

