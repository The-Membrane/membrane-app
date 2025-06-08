import { useQueries, useQuery, UseQueryOptions } from '@tanstack/react-query'
import { getPoolInfo, getPoolLiquidity, useOsmosisClient } from '@/services/osmosis'
import { TotalPoolLiquidityResponse } from 'osmojs/osmosis/poolmanager/v1beta1/query';
import useAppState from '@/persisted-state/useAppState';

export interface PoolLiquidityData {
    poolId: string;
    liquidity: TotalPoolLiquidityResponse;
}

export const usePoolLiquidity = (poolIds: string[]) => {
    const { appState } = useAppState()
    const { data: client } = useOsmosisClient()

    return useQueries({
        queries: (poolIds ?? []).map<UseQueryOptions<PoolLiquidityData, Error, PoolLiquidityData, [string, string, any]>>((id) => ({
            queryKey: ['poolLiquidity', id, client] as [string, string, any], // Explicit tuple type
            queryFn: async () => ({ poolId: id, liquidity: await getPoolLiquidity(id, client) }),
            refetchInterval: false,
            enabled: !!id,
            staleTime: 1000 * 60 * 5,
        })),
    });
}

export const usePoolInfo = (poolId: string) => {
    const { data: client } = useOsmosisClient()
    return useQuery({
        queryKey: ['poolInfo', poolId, client],
        queryFn: async () => getPoolInfo(poolId, client),
    })
}