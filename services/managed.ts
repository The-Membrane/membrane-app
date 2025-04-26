
import contracts from '@/config/contracts.json'
import { getCosmWasmClient, useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { EarnQueryClient } from '@/contracts/codegen/earn/Earn.client'
import { APRResponse, ClaimTracker } from '@/contracts/codegen/earn/Earn.types'
import { BasketPositionsResponse, Uint128 } from '@/contracts/codegen/positions/Positions.types'
import { BasketAsset, getAssetRatio, getDebt, getPositions, getRateCost, getTVL } from './cdp'
import { shiftDigits } from '@/helpers/math'
import { Price } from './oracle'
import { useQuery } from '@tanstack/react-query'
import { ManagedConfig, MarketParams } from '@/components/ManagedMarkets/hooks/useManagerState'
import { IntentResponse } from './earn'
export const getManagedConfig = async (cosmWasmClient: any, marketContract: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        config: {}
    }) as Promise<ManagedConfig>
}

export const getManagedMarket = async (cosmWasmClient: any, marketContract: string, collateral_denom: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        market_params: { collateral_denom }
    }) as Promise<MarketParams>
}

//////////


export const getBoundedTVL = async (cosmWasmClient: any) => {
    return cosmWasmClient.queryContractSmart(contracts.rangeboundLP, {
        total_t_v_l: {}
    }) as Promise<Uint128>
}

export const getBoundedIntents = async (cosmWasmClient: any) => {
    return cosmWasmClient.queryContractSmart(contracts.rangeboundLP, {
        get_user_intent: {
            users: []
        }
    }) as Promise<IntentResponse[]>
}

export const getDepositTokenConversionforMarsUSDC = async (depositAmount: string, cosmWasmClient: any) => {
    return cosmWasmClient.queryContractSmart(contracts.marsUSDCvault, {
        deposit_token_conversion: {
            deposit_token_amount: depositAmount
        }
    }) as Promise<Uint128>
}

export const getUnderlyingUSDC = async (vtAmount: string, client: any) => {
    return client.vaultTokenUnderlying({ vaultTokenAmount: vtAmount }).then((res) => res) as Promise<Uint128>
}

export const getUnderlyingCDT = async (vtAmount: string, cosmWasmClient: any) => {
    return cosmWasmClient.queryContractSmart(contracts.autoStabilityPool, {
        vault_token_underlying: {
            vault_token_amount: vtAmount
        }
    }) as Promise<Uint128>
}

export const getBoundedUnderlyingCDT = async (vtAmount: string, cosmWasmClient: any) => {
    return cosmWasmClient.queryContractSmart(contracts.rangeboundLP, {
        vault_token_underlying: {
            vault_token_amount: vtAmount
        }
    }) as Promise<Uint128>
}


export const getVaultAPRResponse = async (cosmWasmClient: any) => {
    return cosmWasmClient.queryContractSmart(contracts.marsUSDCvault, {
        a_p_r: {}
    }) as Promise<APRResponse>
}

export const getEarnUSDCRealizedAPR = async (client: any) => {
    return client.aPR().then((res) => res) as Promise<ClaimTracker>
}

export const getEarnCDTRealizedAPR = async (cosmWasmClient: any) => {
    return cosmWasmClient.queryContractSmart(contracts.autoStabilityPool, {
        claim_tracker: {}
    }) as Promise<ClaimTracker>
}

export const getBoundedCDTRealizedAPR = async (cosmWasmClient: any) => {
    return cosmWasmClient.queryContractSmart(contracts.rangeboundLP, {
        claim_tracker: {}
    }) as Promise<ClaimTracker>
}

// export const getMarsUSDCSupplyAPR = async (cosmWasmClient: any) => {
//   return cosmWasmClient.queryContractSmart(contracts.marsRedBank, {
//     market: {
//       denom: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4"
//     }
//   }) as Promise<{
//     denom: string,
//     reserve_factor: string,
//     interest_rate_model: any,
//     borrow_index: string,
//     liquidity_index: string,
//     borrow_rate: string,
//     liquidity_rate: string,
//     indexes_last_updated: number,
//     collateral_total_scaled: string,
//     debt_total_scaled: string
//   }>
// }

// export const getEstimatedAnnualInterest = (basketPositions: BasketPositionsResponse[], prices: Price[], userDiscountQueries: any[], basketAssets: BasketAsset[]) => {
//   var totalExpectedRevenue = 0
//   var undiscountedTER = 0
//   //  
//   // // 
//   // var debtTallies = [0,0,0, 0]
//   //   console.log("above map", basketPositions)
//   basketPositions?.forEach((basketPosition, index) => {
//     var debt = getDebt([basketPosition])
//     if (!debt || debt <= 1000) return
//     if (basketPosition.user == contracts.earn) debt = debt * 0.75
//     // debtTallies[0] += 1
//     // console.log("in map", basketPosition)
//     const positions = getPositions([basketPosition], prices)
//     const tvl = getTVL(positions)
//     const positionsWithRatio = getAssetRatio(false, tvl, positions)

//     // console.log("above discount")
//     const discountRatio = userDiscountQueries[index]?.data?.discount || "0";
//     // console.log("discount", discountRatio)
//     const cost = getRateCost(positions, tvl, basketAssets, positionsWithRatio).cost
//     const discountedCost = cost * (1 - Number(discountRatio))
//     const annualInterest = !Number.isNaN(cost) ? cost * shiftDigits(debt, 6).toNumber() : 0
//     const discountedAnnualInterest = !Number.isNaN(discountedCost) ? discountedCost * shiftDigits(debt, 6).toNumber() : 0
//     // console.log("annualInterest", annualInterest, "discountedAnnualInterest", discountedAnnualInterest)
//     totalExpectedRevenue += discountedAnnualInterest
//     undiscountedTER += annualInterest
//   })
//   // console.log("debtTallies", debtTallies)

//   return { totalExpectedRevenue, undiscountedTER }
// }


