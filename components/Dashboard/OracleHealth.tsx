import { useBasket } from '@/hooks/useCDP';
import React, { useMemo, useState } from 'react';
import { AssetInfo, AssetResponse } from '@/contracts/codegen/oracle/Oracle.types'
import { useOracleAssetInfos, useOracleConfig, useOraclePrice } from '@/hooks/useOracle';
import { PoolLiquidityData, usePoolLiquidity } from '@/hooks/useOsmosis';
import { Price } from '@/services/oracle';

const HealthStatus = ({ health = 100, label = "N/A" }) => {
    const [isHovered, setIsHovered] = useState(false);

    // Calculate color based on health value
    const getHealthColor = () => {
        if (health >= 70) return 'bg-green-500';
        if (health >= 30) return 'bg-yellow-500';
        return 'bg-red-500';
    };

    // Get status text based on health
    const getStatusText = () => {
        if (health >= 70) return 'Healthy';
        if (health >= 30) return 'Warning';
        return 'Critical';
    };

    return (
        <div className="flex items-center bg-gray-100 p-4 rounded-lg shadow-sm w-64">
            <div className="relative">
                <div
                    className={`w-12 h-12 rounded-full ${getHealthColor()} transition-colors duration-300`}
                    onMouseEnter={() => setIsHovered(true)}
                    onMouseLeave={() => setIsHovered(false)}
                />

                {/* Hover tooltip */}
                {isHovered && (
                    <div className="absolute -top-14 left-0 bg-gray-800 text-white p-2 rounded text-sm whitespace-nowrap">
                        Health: {health}% - {getStatusText()}
                    </div>
                )}
            </div>

            <div className="ml-4 text-xl font-semibold text-gray-800">
                label
            </div>
        </div>
    );
};

function transformAssets(assets: AssetResponse[]): { asset_info: AssetInfo; pool_IDs: number[] }[] {
    return assets.map(({ asset_info, oracle_info }) => {
        // Create pool_IDs from the oracle_info
        const pool_IDs = oracle_info.flatMap(({ lp_pool_info, pools_for_osmo_twap }) => [
            ...(lp_pool_info ? [lp_pool_info.pool_id] : []),
            ...pools_for_osmo_twap.map(pool => pool.pool_id),
        ]);

        // Check if asset_info is of type native_token with denom 'usomo'
        if ('native_token' in asset_info && asset_info.native_token.denom === 'usomo') {
            // Manually add pool IDs for 'usomo'
            pool_IDs.push(678);  // Example: Add specific pool ID for usomo, replace with actual logic
        }

        // Return transformed object
        return { asset_info, pool_IDs };
    });
}


export type PoolTotalValueMap = Record<string, number>; // { poolId: totalValue }

function calculateTotalPoolValues(
    poolLiquidityData: PoolLiquidityData[],
    prices: Price[]
): PoolTotalValueMap {
    // Convert prices array into a lookup map { denom: price }
    const priceMap = new Map(prices.map(({ denom, price }) => [denom, Number(price)]));

    return poolLiquidityData.reduce<PoolTotalValueMap>((acc, { poolId, liquidity }) => {
        let totalValue = 0;

        for (const asset of liquidity.liquidity) {
            const assetPrice = priceMap.get(asset.denom) || 0;
            totalValue += Number(asset.amount) * assetPrice;
        }

        acc[poolId] = totalValue;
        return acc;
    }, {});
}

export const OracleHealth = () => {
    //We'll forego using the config to get the OSMO pool ID for now, and just hardcode it
    // const { data: config } = useOracleConfig()
    const { data: prices } = useOraclePrice()
    const { data: basket } = useBasket()
    const usedAssets = useMemo(() => {
        if (!basket) return []
        return basket.collateral_supply_caps
            .filter((cap) => Number(cap.supply_cap_ratio) > 0)
            //@ts-ignore
            .map((cap) => (cap.asset_info as AssetInfo),  // Directly assign if you're sure it's always a native_token
            );
    }, [basket])
    // console.log("usedAssets", usedAssets)
    const { data: assetInfos } = useOracleAssetInfos(usedAssets)
    // console.log("assetInfos", assetInfos)
    //Get pool IDS for each asset
    const poolIDsPerAsset = useMemo(() => {
        if (!assetInfos) return []
        return transformAssets(assetInfos)
    }, [assetInfos])
    const poolIDs = poolIDsPerAsset.flatMap(({ pool_IDs }) => pool_IDs.toString())
    // console.log("poolIDsPerAsset", poolIDsPerAsset)

    //Query pool liquidity for each pool
    const poolData = usePoolLiquidity(poolIDs)
    const poolLiquidityData = useMemo(() => {
        return poolData
            .map(query => query.data) // Extract only the `data` property
            .filter((data): data is PoolLiquidityData => data !== undefined); // Remove undefined results
    }, [poolData]);
    // console.log("poolLiquidityData", poolLiquidityData)


    //Create a map of pool ID to liquidity value
    const totalPoolValues = useMemo(() => {
        if (!prices || !poolLiquidityData) return {}
        return calculateTotalPoolValues(poolLiquidityData, prices)
    }, [prices, poolLiquidityData])
    // console.log("totalPoolValues", totalPoolValues)

    //Calculate the value of usedAssets in USD using basket.collateral_supply_caps.current_supply * price
    const assetValues = useMemo(() => {
        if (!basket || !prices) return []
        return basket.collateral_supply_caps.map((cap) => {
            const assetPrice = prices.find((price) => price.denom === cap.asset_info.native_token.denom)?.price
            const value = Number(cap.current_supply) * Number(assetPrice)
            return { name: cap.asset_info.native_token.denom, value }
        })
    }, [basket, prices])
    console.log("assetValues", assetValues)

    //Group pool values by asset
    const poolValuesByAsset = useMemo(() => {
        if (!poolIDsPerAsset || !totalPoolValues) return []
        return poolIDsPerAsset.map(({ asset_info, pool_IDs }) => {
            const totalValue = pool_IDs.reduce((acc, poolID) => acc + (totalPoolValues[poolID] || 0), 0)
            return { name: asset_info.native_token.denom, value: totalValue }
        })
    }, [poolIDsPerAsset, totalPoolValues])

    console.log("poolValuesByAsset", poolValuesByAsset)

    //Create health object for each asset using the formula: (assetValue / poolValuesByAsset) * 100
    const healthData = useMemo(() => {
        return assetValues.map(({ name, value }) => {
            const poolValue = poolValuesByAsset.find((asset) => asset.name === name)?.value
            const health = (((value / (poolValue ?? 1)) * 100) - 1) * -1
            return { name, health }
        })
    }, [assetValues, poolValuesByAsset])

    console.log("healthData", healthData)

    return (
        <div className="grid grid-cols-3 gap-4">
            {healthData.map(({ name, health }) => (
                <HealthStatus key={name} health={health} label={name} />
            ))}
        </div>
    )

}