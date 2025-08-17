
import contracts from '@/config/contracts.json'
import { getCosmWasmClient, useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { EarnQueryClient } from '@/contracts/codegen/earn/Earn.client'
import { APRResponse, ClaimTracker } from '@/contracts/codegen/earn/Earn.types'
import { BasketPositionsResponse, Uint128 } from '@/contracts/codegen/positions/Positions.types'
import { BasketAsset, getAssetRatio, getDebt, getPositions, getRateCost, getTVL } from './cdp'
import { shiftDigits } from '@/helpers/math'
import { Price } from './oracle'
import { useQuery } from '@tanstack/react-query'
import useAppState from '@/persisted-state/useAppState'

export type PurchaseIntent = {
  desired_asset: string,
  route: any | undefined,
  yield_percent: string,
  position_id: number | undefined,
  slippage: string | undefined
}

export type IntentResponse = {
  user: string,
  intent: {
    vault_tokens: string,
    intents: {
      user: string,
      last_conversion_rate: string,
      purchase_intents: PurchaseIntent[]
    },
    unstake_time: number,
    fee_to_caller: string
  }
}
export const useEarnClient = () => {
  const { appState } = useAppState()
  const { data: cosmWasmClient } = useCosmWasmClient(appState.rpcUrl)

  return useQuery({
    queryKey: ['earn_client', cosmWasmClient],
    queryFn: async () => {
      if (!cosmWasmClient) return null
      return new EarnQueryClient(cosmWasmClient, contracts.earn)
    },
    // enabled: true,
    // You might want to add staleTime to prevent unnecessary refetches
    staleTime: 1000 * 60 * 5, // 5 minutes
  })
}


export const EarnClient = async (rpcUrl: string) => {
  const cosmWasmClient = await getCosmWasmClient(rpcUrl)
  return new EarnQueryClient(cosmWasmClient, contracts.earn)
}
// export const usdcVaultClient = async () => {
//   return new EarnQueryClient(cosmWasmClient, contracts.earn)
// }

export const getBoundedConfig = async (cosmWasmClient: any) => {
  return cosmWasmClient.queryContractSmart(contracts.rangeboundLP, {
    config: {}
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

export const getMarsUSDCSupplyAPR = async (cosmWasmClient: any) => {
  return cosmWasmClient.queryContractSmart(contracts.marsRedBank, {
    market: {
      denom: "ibc/498A0751C798A0D9A389AA3691123DADA57DAA4FE165D5C75894505B876BA6E4"
    }
  }) as Promise<{
    denom: string,
    reserve_factor: string,
    interest_rate_model: any,
    borrow_index: string,
    liquidity_index: string,
    borrow_rate: string,
    liquidity_rate: string,
    indexes_last_updated: number,
    collateral_total_scaled: string,
    debt_total_scaled: string
  }>
}

export const getEstimatedAnnualInterest = (basketPositions: BasketPositionsResponse[], prices: Price[], userDiscountQueries: any[], basketAssets: BasketAsset[]) => {
  var totalExpectedRevenue = 0
  var undiscountedTER = 0
  //  
  // // 
  // var debtTallies = [0,0,0, 0]
  //   console.log("above map", basketPositions)
  basketPositions?.forEach((basketPosition, index) => {
    var debt = getDebt([basketPosition])
    if (!debt || debt <= 1000) return
    if (basketPosition.user == contracts.earn) debt = debt * 0.75
    // debtTallies[0] += 1
    // console.log("in map", basketPosition)
    const positions = getPositions([basketPosition], prices)
    const tvl = getTVL(positions)
    const positionsWithRatio = getAssetRatio(false, tvl, positions)

    // console.log("above discount")
    const discountRatio = userDiscountQueries[index]?.data?.discount || "0";
    // console.log("discount", discountRatio)
    const cost = getRateCost(positions, tvl, basketAssets, positionsWithRatio).cost
    const discountedCost = cost * (1 - Number(discountRatio))
    const annualInterest = !Number.isNaN(cost) ? cost * shiftDigits(debt, 6).toNumber() : 0
    const discountedAnnualInterest = !Number.isNaN(discountedCost) ? discountedCost * shiftDigits(debt, 6).toNumber() : 0
    // console.log("annualInterest", annualInterest, "discountedAnnualInterest", discountedAnnualInterest)
    totalExpectedRevenue += discountedAnnualInterest
    undiscountedTER += annualInterest
  })
  // console.log("debtTallies", debtTallies)

  return { totalExpectedRevenue, undiscountedTER }
}


