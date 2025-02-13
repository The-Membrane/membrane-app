import { useQueries, useQuery, UseQueryOptions } from '@tanstack/react-query'
import { getPoolLiquidity } from '@/services/osmosis'
import { TotalPoolLiquidityResponse } from 'osmojs/osmosis/poolmanager/v1beta1/query';

export interface PoolLiquidityData {
    poolId: string;
    liquidity: TotalPoolLiquidityResponse;
}

export const usePoolLiquidity = (poolIds: string[]) => {

    return useQueries({
        queries: (poolIds ?? []).map<UseQueryOptions<PoolLiquidityData, Error, PoolLiquidityData, [string, string]>>((id) => ({
            queryKey: ['poolLiquidity', id] as [string, string], // Explicit tuple type
            queryFn: async () => ({ poolId: id, liquidity: await getPoolLiquidity(id) }),
            refetchInterval: false,
            enabled: !!id,
            staleTime: 1000 * 60 * 5,
        })),
    });
}