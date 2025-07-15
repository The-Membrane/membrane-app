import contracts from '@/config/contracts.json'
import { getCosmWasmClient, useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { EarnQueryClient } from '@/contracts/codegen/earn/Earn.client'
import { APRResponse, ClaimTracker } from '@/contracts/codegen/earn/Earn.types'
import { BasketPositionsResponse, Uint128 } from '@/contracts/codegen/positions/Positions.types'
import { BasketAsset, getAssetRatio, getDebt, getPositions, getRateCost, getTVL } from './cdp'
import { shiftDigits } from '@/helpers/math'
import { Price } from './oracle'
import { useQuery } from '@tanstack/react-query'
import { ManagedConfig, MarketConfig, MarketData, MarketParams } from '@/components/ManagedMarkets/hooks/useManagerState'
import { IntentResponse } from './earn'
import { start } from 'repl'
import { PriceResponse } from '@/contracts/codegen/oracle/Oracle.types'
import { useAllMarkets } from '@/hooks/useManaged'
import { useMemo } from 'react'
import type { Asset } from '@/helpers/chain'
import type { CosmWasmClient } from '@cosmjs/cosmwasm-stargate'


export interface UserPosition {
    collateral_denom: string, 
    collateral_amount: string,
    debt_amount: string,
    rate_index: string,
}
export interface UserPositionResponse {
    user: string,
    position: UserPosition
}

export interface UXBoosts {
    collateral_value_fee_to_executor: string, 
    loop_ltv: any,
    take_profit_params: any,
    stop_loss_params: any,
    arb_price: any,
    collateral_bought_from_loops: any[]
}

export const getManagers = async (cosmWasmClient: any) => {
    return cosmWasmClient.queryContractSmart(contracts.marketManager, {
        managers: {
            start_after: undefined,
            limit: undefined,
        }
    }) as Promise<string[]>
    //returns addresses of 32 managers
}

export const getManagedMarketContracts = async (cosmWasmClient: any, manager: string) => {
    return cosmWasmClient.queryContractSmart(contracts.marketManager, {
        markets_managed: {
            manager
        }
    }) as Promise<string[]>
    //returns addresses of all managed markets
}

//readd is_junior
export const getManagedMarketUnderlyingCDT = async (cosmWasmClient: any, marketContract: string, vault_token_amount: string, is_junior: boolean) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        get_underlying_debt_amount: { vault_token_amount, is_junior }
    }) as Promise<string>
}

export const getManagedConfig = async (cosmWasmClient: any, marketContract: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        config: {}
    }) as Promise<ManagedConfig>
}

export const getManagedUXBoosts = async (cosmWasmClient: any, marketContract: string, collateral_denom: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        get_user_u_x_boosts: { collateral_denom }
    }) as Promise<UXBoosts[]>
}

export const getManagedMarket = async (cosmWasmClient: any, marketContract: string, collateral_denom: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        market_params: { collateral_denom }
    }) as Promise<MarketParams[]>
}

export const getTotalBorrowed = async (cosmWasmClient: any, marketContract: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        get_total_borrowed: {}
    }) as Promise<Uint128>
}

export const getManagedMarkets = async (cosmWasmClient: any, manager: string) => {
    return cosmWasmClient.queryContractSmart(contracts.marketManager, {
        market_params: {
            manager,
            start_after: undefined,
            limit: undefined
        }
    }) as Promise<MarketData[]>
}

////////// 

//Get market name from address
export const getMarketName = (marketAddress: string) => {

    const allMarkets = useAllMarkets();
    const marketName = useMemo(() => {
        if (allMarkets && marketAddress) {
            const found = allMarkets.find((m: any) => m.address === marketAddress);
            if (found) return found.name;
        }
        return 'Unnamed Market';
    }, [allMarkets, marketAddress]);

    return marketName
}

// Batch hook to get market names for an array of addresses
export const useMarketNames = (marketAddresses: string[]) => {
    const allMarkets = useAllMarkets();
    // console.log('allMarkets', allMarkets);
    return useMemo(() => {
        return marketAddresses.map(address => {
            if (allMarkets && address) {
                const found = allMarkets.find((m: any) => m.address === address);

                if (found) return found.name;
            }
            return 'Unnamed Market';
        });
    }, [allMarkets, marketAddresses]);
}

export const getMarketCollateralDenoms = async (cosmWasmClient: any, marketContract: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        get_collateral_assets: {}
    }) as Promise<string[]>
}


export const getMarketCollateralPrice = async (cosmWasmClient: any, marketContract: string, collateral_denom: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        get_collateral_price: { asset: collateral_denom }
    }) as Promise<PriceResponse>
}

export const getMarketDebtPrice = async (cosmWasmClient: any, marketContract: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        get_debt_price: {}
    }) as Promise<PriceResponse>
}

export const getMarketCollateralCost = async (cosmWasmClient: any, marketContract: string, collateral_denom: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        get_current_interest_rate: { collateral_denom }
    }) as Promise<string>
}

export const getMarketClaimTracker = async (cosmWasmClient: any, marketContract: string, is_junior: boolean) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        claim_tracker: { is_junior }
    }) as Promise<ClaimTracker>
}

export const getUserPositioninMarket = async (cosmWasmClient: any, marketContract: string, collateral_denom: string, user: string) => {
    
    return cosmWasmClient.queryContractSmart(marketContract, {
        get_user_positions: { 
            collateral_denom: collateral_denom,
            user: user,
            start_after: undefined,
            limit: undefined
         }
    }) as Promise<UserPositionResponse[]>
}


export const getUserUXBoostsinMarket = async (cosmWasmClient: any, marketContract: string, collateral_denom: string, user: string) => {
    
    return cosmWasmClient.queryContractSmart(marketContract, {
        get_user_ux_boosts: { 
            collateral_denom: collateral_denom,
            user: user
         }
    }) as Promise<UXBoosts>
}

export const getMarketBalance = async (
    client: CosmWasmClient,
    asset: Asset,
    address: string,
): Promise<string> => {
    if (!client || !asset || !address) {
        console.error('Failed to get market balance', { client, asset, address });
        return '0';
    }
    // Native token
    try {
        const balance = await client.getBalance(address, asset.base);
        return shiftDigits(balance.amount, -(asset.decimal || 6)).toString();
    } catch (e) {
        console.error('Failed to get native balance', e);
        return '0';
    }
};




