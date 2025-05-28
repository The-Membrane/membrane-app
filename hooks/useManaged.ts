import { useQuery } from '@tanstack/react-query'
import { getBasket, getUserPositions, getCollateralInterest, getCreditRate, getBasketPositions, getUserDiscount, getBasketAssets, getUserRedemptionInfo, useCDPClient } from '@/services/cdp'
import useWallet from './useWallet'
import useAssets from './useAssets'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { useRouter } from 'next/router'
import { getManagedConfig, getManagedMarket, getManagedMarketContracts, getManagedMarkets, getManagers, getMarketCollateralCost, getMarketCollateralPrice, getMarketDebtPrice } from '@/services/managed'
import { useState, useEffect, useMemo } from 'react'
import { MarketData } from '@/components/ManagedMarkets/hooks/useManagerState'
import { Asset, getAssetByDenom } from '@/helpers/chain'
import { useBalanceByAsset } from './useBalance'
import { useOraclePrice } from './useOracle'
import { num } from '@/helpers/num'
import { useChainRoute } from './useChainRoute'




export const useManagers = () => {
    const { data: client } = useCosmWasmClient()
    const router = useRouter()

    return useQuery({
        queryKey: ['market_managers', client],
        queryFn: async () => {
            if (!router.pathname.endsWith("/managed")) return
            if (!client) return
            return getManagers(client)
        },
        // enabled: true,
        // You might want to add staleTime to prevent unnecessary refetches
        staleTime: 1000 * 60 * 5, // 5 minutes
    })
}


export const useManagedMarketContracts = (manager: string) => {
    const { data: client } = useCosmWasmClient()
    const router = useRouter()

    return useQuery({
        queryKey: ['managed_market_contracts', client, manager],
        queryFn: async () => {
            if (!router.pathname.endsWith("/managed")) return
            if (!client) return
            return getManagedMarketContracts(client, manager)
        },
        // enabled: true,
        // You might want to add staleTime to prevent unnecessary refetches
        staleTime: 1000 * 60 * 5, // 5 minutes
    })
}

export const useManagedConfig = (marketContract: string) => {
    const { data: client } = useCosmWasmClient()
    const router = useRouter()

    return useQuery({
        queryKey: ['managed_market_config', client, marketContract],
        queryFn: async () => {
            if (!router.pathname.endsWith("/managed")) return
            if (!client) return
            return getManagedConfig(client, marketContract)
        },
        // enabled: true,
        // You might want to add staleTime to prevent unnecessary refetches
        staleTime: 1000 * 60 * 5, // 5 minutes
    })

}

export const useManagedMarket = (marketContract: string, collateral_denom: string) => {
    const { data: client } = useCosmWasmClient()
    const router = useRouter()

    return useQuery({
        queryKey: ['managed_market_params', client, marketContract, collateral_denom],
        queryFn: async () => {
            if (!router.pathname.endsWith("/managed")) return
            if (!client) return
            return getManagedMarket(client, marketContract, collateral_denom)
        },
        staleTime: 1000 * 60 * 5,
    })
}

function usePromise<T>(promise: Promise<T> | null) {
    const [data, setData] = useState<T | null>(null);

    useEffect(() => {
        if (!promise) return;

        promise.then(setData).catch((err) => {
            console.error("usePromise error:", err);
        });
    }, [promise]);

    return { data };
}

export const useAllMarkets = () => {
    const { data: managers } = useManagers();
    const { data: client } = useCosmWasmClient();

    const markets = useMemo(() => {
        if (!managers || !client) return null;

        return Promise.all(
            managers.map(async (manager) => {
                const markets = await getManagedMarkets(client, manager);
                return markets.map(market => ({
                    ...market,
                    manager,
                }));
            })
        ).then(results => results.flat());
    }, [managers, client]);

    const { data: managedMarkets } = usePromise(markets);

    // Memoize the final result so consumers always get a stable reference
    return useMemo(() => managedMarkets, [managedMarkets]);
};

//Use market collateral price
export const useMarketCollateralPrice = (marketContract: string, collateral_denom: string) => {
    const { data: client } = useCosmWasmClient();
    return useQuery({
        queryKey: ['managed_market_collateral_price', client, marketContract, collateral_denom],
        queryFn: async () => getMarketCollateralPrice(client, marketContract, collateral_denom),
    })
}

//Use market debt price
export const useMarketDebtPrice = (marketContract: string) => {
    const { data: client } = useCosmWasmClient();
    return useQuery({
        queryKey: ['managed_market_debt_price', client, marketContract],
        queryFn: async () => getMarketDebtPrice(client, marketContract),
    })
}

//Use market collateral cost
export const useMarketCollateralCost = (marketContract: string, collateral_denom: string) => {
    const { data: client } = useCosmWasmClient();
    return useQuery({
        queryKey: ['managed_market_collateral_cost', client, marketContract, collateral_denom],
        queryFn: async () => getMarketCollateralCost(client, marketContract, collateral_denom),
    })
}


export const useMarketsTableData = () => {
    const allMarkets = useAllMarkets();
    const { chainName } = useChainRoute();
    const assets = useAssets(chainName);
    const { data: client } = useCosmWasmClient();
    const { data: prices } = useOraclePrice();

    // Helper to format TVL as $X.XXK/M
    function formatTvl(val: string | number): string {
        let n = typeof val === 'number' ? val : parseFloat(val);
        if (isNaN(n)) return '$0';
        if (n >= 1e6) return `$${(n / 1e6).toFixed(2)}M`;
        if (n >= 1e3) return `$${(n / 1e3).toFixed(2)}K`;
        return `$${n.toFixed(2)}`;
    }
    // Helper to format multiplier as 'X.XXx'
    function formatMultiplier(val: number): string {
        return `${val.toFixed(2)}x`;
    }
    // Helper to format cost as 'X.XX%'
    function formatCost(val: string | number): string {
        let n = typeof val === 'number' ? val : parseFloat(val);
        if (isNaN(n)) return '0%';
        return `${(n * 100).toFixed(2)}%`;
    }

    // console.log("Managed Markets Data", allMarkets, client, assets, prices)

    const { data: tableData } = useQuery({
        queryKey: ['markets_table_data', allMarkets, client, assets, prices],
        queryFn: async () => {
            // console.log("Managed Markets Data", allMarkets, client, assets, prices)
            if (!allMarkets || !client || !assets || !prices) return [];
            console.log("allMarkets", allMarkets)
            return Promise.all(
                allMarkets.map(async (market) => {
                    const denom = market.params?.collateral_params?.collateral_asset;
                    const asset = getAssetByDenom(denom, 'osmosis');
                    console.log("asset", asset)
                    let assetBalance = '0';
                    let assetSymbol = denom;
                    if (asset) {
                        assetBalance = useBalanceByAsset(asset, 'osmosis', market.address);
                        assetSymbol = asset.symbol;
                    }
                    console.log("assetBalance", assetBalance)
                    //Get asset price
                    const { data: collateralPrice } = useMarketCollateralPrice(market.address, denom);
                    //Get cost value
                    let costValue = '0';
                    try {
                        costValue = await getMarketCollateralCost(client, market.address, denom);
                    } catch (e) {}
                    // Format multiplier
                    let multiplier = 1;
                    try {
                        multiplier = 1 / (1 - Number(market.params?.collateral_params.max_borrow_LTV || 0));
                    } catch (e) {}
                    // Format TVL
                    let tvl = 0;
                    try {
                        tvl = num(assetBalance).times(collateralPrice?.price || 0).toNumber();
                    } catch (e) {}
                    return {
                        marketAddress: market.address,
                        asset: assetSymbol,
                        tvl: formatTvl(tvl),
                        vaultName: market.name,
                        multiplier: formatMultiplier(multiplier),
                        cost: formatCost(costValue),
                    };
                })
            );
        }
    });

    console.log("tableData",tableData)
    if (!tableData) {
        return []
    }

    console.log("tableData",tableData)

    return tableData;
};
