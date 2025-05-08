import { useQuery } from '@tanstack/react-query'
import { getBasket, getUserPositions, getCollateralInterest, getCreditRate, getBasketPositions, getUserDiscount, getBasketAssets, getUserRedemptionInfo, useCDPClient } from '@/services/cdp'
import useWallet from './useWallet'
import useAssets from './useAssets'
import { useCosmWasmClient } from '@/helpers/cosmwasmClient'
import { useRouter } from 'next/router'
import { getManagedConfig, getManagedMarket, getManagedMarketContracts, getManagedMarkets, getManagers } from '@/services/managed'
import { useState, useEffect, useMemo } from 'react'
import { MarketData } from '@/components/ManagedMarkets/hooks/useManagerState'




export const useManagers = () => {
    const { data: client } = useCosmWasmClient()
    const router = useRouter()

    return useQuery({
        queryKey: ['market_managers', client],
        queryFn: async () => {
            if (!router.pathname.startsWith("/managed")) return
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
            if (!router.pathname.startsWith("/managed")) return
            if (!client) return
            return getManagedMarketContracts(client, manager)
        },
        // enabled: true,
        // You might want to add staleTime to prevent unnecessary refetches
        staleTime: 1000 * 60 * 5, // 5 minutes
    })
}

export const useMarketConfig = (marketContract: string) => {
    const { data: client } = useCosmWasmClient()
    const router = useRouter()

    return useQuery({
        queryKey: ['managed_market_config', client, marketContract],
        queryFn: async () => {
            if (!router.pathname.startsWith("/managed")) return
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
            if (!router.pathname.startsWith("/managed")) return
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

    return managedMarkets;
};
