import { useBasket } from '@/hooks/useCDP';
import React, { useMemo, useState } from 'react';
import { AssetInfo, AssetResponse } from '@/contracts/codegen/oracle/Oracle.types'
import { useOracleAssetInfos, useOracleConfig, useOraclePrice } from '@/hooks/useOracle';
import { PoolLiquidityData, usePoolLiquidity } from '@/hooks/useOsmosis';
import { Price } from '@/services/oracle';
import { getAssetByDenom, getAssetsByDenom } from '@/helpers/chain';
import { shiftDigits } from '@/helpers/math';
import { Box, Text, Circle, Tooltip, Stack } from "@chakra-ui/react";
import { colors } from '@/config/defaults';
import { useChainAssets } from '@/hooks/useChainAssets'

const HealthStatus = ({ health = 100, label = "N/A" }) => {
    // Calculate color based on health value
    const getHealthColor = () => {
        if (health >= 70) return "green.500";
        if (health >= 30) return "yellow.500";
        return "red.500";
    };

    // Get status text based on health
    const getStatusText = () => {
        if (health >= 70) return "Healthy";
        if (health >= 30) return "Warning";
        return "Critical";
    };

    return (
        <Box display="flex" alignItems="center" bg="gray.100" p={4} borderRadius="lg" shadow="sm" w="150px" h="52px">
            <Tooltip label={`Health: ${health.toFixed(2)}% - ${getStatusText()}`} hasArrow bg="gray.800" color="white">
                <Circle size="30px" bg={getHealthColor()} border="1px solid" borderColor="gray.400" />
            </Tooltip>

            <Text ml={1} fontSize="12px" fontWeight="semibold" color="gray.800">
                {label}
            </Text>
        </Box>
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
            // Manually add pool ID for 'usomo'
            pool_IDs.push(678);
        }

        // Return transformed object
        return { asset_info, pool_IDs };
    });
}


export type PoolTotalValueMap = Record<string, number>; // { poolId: totalValue }

function calculateTotalPoolValues(
    poolLiquidityData: PoolLiquidityData[],
    prices: Price[],
    assetDecimals: { decimal: number; denom: string }[]
): PoolTotalValueMap {
    // Convert prices array into a lookup map { denom: price }
    const priceMap = new Map(prices.map(({ denom, price }) => [denom, Number(price)]));

    return poolLiquidityData.reduce<PoolTotalValueMap>((acc, { poolId, liquidity }) => {
        let totalValue = 0;

        for (const asset of liquidity.liquidity) {
            // console.log("asset", poolId, asset)
            const assetPrice = priceMap.get(asset.denom) || 0;
            const assetDecimal = assetDecimals.find(({ denom }) => denom === asset.denom)?.decimal || 6;
            const assetAmount = shiftDigits(asset.amount, -assetDecimal);
            totalValue += assetAmount.times(assetPrice).toNumber();
        }

        acc[poolId] = totalValue;
        return acc;
    }, {});
}

export const OracleHealth = () => {
    const { getAssetsByDenom } = useChainAssets()
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
    //@ts-ignore
    const usedDenoms = usedAssets.map((asset) => asset.native_token.denom)
    const assetObjects = getAssetsByDenom(usedDenoms)
    const assetDecimals = assetObjects.map((asset) => ({ decimal: asset.decimal || 6, denom: asset.base }))
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
        return calculateTotalPoolValues(poolLiquidityData, prices, assetDecimals)
    }, [prices, poolLiquidityData, assetDecimals])
    // console.log("totalPoolValues", totalPoolValues)

    //Calculate the value of usedAssets in USD using basket.collateral_supply_caps.current_supply * price
    const assetValues = useMemo(() => {
        if (!basket || !prices) return []
        return basket.collateral_supply_caps.map((cap) => {
            const assetPrice = prices.find((price) => price.denom === cap.asset_info.native_token.denom)?.price || 0
            const assetDecimal = assetDecimals.find(({ denom }) => denom === cap.asset_info.native_token.denom)?.decimal || 6;
            const assetAmount = shiftDigits(cap.current_supply, -assetDecimal);
            return { name: cap.asset_info.native_token.denom, value: assetAmount.times(assetPrice).toNumber() }
        })
    }, [basket, prices])
    // console.log("assetValues", assetValues)

    //Group pool values by asset
    const poolValuesByAsset = useMemo(() => {
        if (!poolIDsPerAsset || !totalPoolValues) return []
        return poolIDsPerAsset.map(({ asset_info, pool_IDs }) => {
            const totalValue = pool_IDs.reduce((acc, poolID) => acc + (totalPoolValues[poolID] || 0), 0)
            return { name: asset_info.native_token.denom, value: totalValue }
        })
    }, [poolIDsPerAsset, totalPoolValues])

    // console.log("poolValuesByAsset", poolValuesByAsset)

    //Create health object for each asset using the formula: (assetValue / poolValuesByAsset) * 100
    const healthData = useMemo(() => {
        return assetValues.map(({ name, value }) => {
            const poolValue = poolValuesByAsset.find((asset) => asset.name === name)?.value
            if (!poolValue) return
            const health = value > poolValue ? 0 : ((poolValue - value) / poolValue) * 100;
            //Cahnge name to symbol
            const symbolName = assetObjects.find((asset) => asset.base === name)?.symbol || name
            return { name: symbolName, health }
        })
    }, [assetValues, poolValuesByAsset])

    // console.log("healthData", healthData)

    return (
        <Stack>
            <Text fontWeight="bold" fontFamily="Inter" fontSize={"xl"} letterSpacing={"1px"} display="flex" color={colors.earnText}>Oracle Pool Health</Text>
            <div style={{
                display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem",
                backgroundColor: colors.globalBG, // Color the gaps
                padding: "10px", // Ensures outer gaps are also colored
                border: "2px solid white",
            }}>
                {healthData.filter((entry): entry is { name: any; health: number } => entry !== undefined)
                    .map(({ name, health }) => (
                        <HealthStatus key={name} health={health} label={name} />
                    ))}

            </div>
        </Stack>
    )

}