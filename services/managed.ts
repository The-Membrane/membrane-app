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

export const getManagedConfig = async (cosmWasmClient: any, marketContract: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        config: {}
    }) as Promise<ManagedConfig>
}

export const getManagedMarket = async (cosmWasmClient: any, marketContract: string, collateral_denom: string) => {
    return cosmWasmClient.queryContractSmart(marketContract, {
        market_params: { collateral_denom }
    }) as Promise<MarketParams[]>
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


