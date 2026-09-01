import { useBasket } from '@/hooks/useCDP';
import React, { useMemo, useState } from 'react';
import { AssetInfo, AssetResponse } from '@/contracts/codegen/oracle/Oracle.types'
import { useOracleAssetInfos, useOracleConfig, useOraclePrice } from '@/hooks/useOracle';
import { PoolLiquidityData, usePoolLiquidity } from '@/hooks/useOsmosis';
import { Price } from '@/services/oracle';
import { getAssetByDenom, getAssetsByDenom } from '@/helpers/chain';
import { shiftDigits } from '@/helpers/math';
import { Box, Text, Circle, Tooltip, Stack } from "@chakra-ui/react";
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { Card } from '@/components/ui/Card';
import { useChainRoute } from '@/hooks/useChainRoute';
import useAppState from '@/persisted-state/useAppState';

const HealthStatus = ({ health = 100, label = "N/A" }) => {
    // Calculate color based on health value
    const getHealthColor = () => {
        if (health >= 70) return SEMANTIC_COLORS.success;
        if (health >= 30) return SEMANTIC_COLORS.warning;
        return SEMANTIC_COLORS.danger;
    };

    // Get status text based on health
    const getStatusText = () => {
        if (health >= 70) return "Healthy";
        if (health >= 30) return "Warning";
        return "Critical";
    };

    return (
        <Card display="flex" alignItems="center" p={SPACING.base} w="150px" h="52px">
            <Tooltip label={`Health: ${health.toFixed(2)}% - ${getStatusText()}`} hasArrow bg={SEMANTIC_COLORS.bgSecondary} color={SEMANTIC_COLORS.textPrimary}>
                <Circle size="30px" bg={getHealthColor()} border="1px solid" borderColor={SEMANTIC_COLORS.borderStrong} />
            </Tooltip>

            <Text ml={1} fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} fontWeight={TYPOGRAPHY.semibold} color={SEMANTIC_COLORS.textSecondary}>
                {label}
            </Text>
        </Card>
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
    //We'll forego using the config to get the OSMO pool ID for now, and just hardcode it
    // const { data: config } = useOracleConfig()
    const { data: prices } = useOraclePrice()
    const { appState } = useAppState()
    const { data: basket } = useBasket(appState.rpcUrl)
    const usedAssets = useMemo(() => {
        // TODO(evm-migration): basket is null-stubbed (no aggregate basket view in Cdp.sol);
        // collateral_supply_caps has no faithful EVM equivalent here yet, so read defensively.
        const b = basket as any
        if (!b || !b.collateral_supply_caps) return []
        return b.collateral_supply_caps.flatMap((cap: any) => {
            if (!(Number(cap.supply_cap_ratio) > 0)) return []
            //@ts-ignore
            return [(cap.asset_info as AssetInfo)] // Directly assign if you're sure it's always a native_token
        });
    }, [basket])
    //@ts-ignore
    const usedDenoms = usedAssets.map((asset: any) => asset.native_token.denom)
    const { chainName } = useChainRoute()
    const assetObjects = getAssetsByDenom(usedDenoms, chainName)
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
        return (basket as any).collateral_supply_caps.map((cap: any) => {
            const assetPrice = prices.find((price) => price.denom === cap.asset_info.native_token.denom)?.price || 0
            const assetDecimal = assetDecimals.find(({ denom }) => denom === cap.asset_info.native_token.denom)?.decimal || 6;
            const assetAmount = shiftDigits(cap.current_supply, -assetDecimal);
            return { name: cap.asset_info.native_token.denom, value: assetAmount.times(assetPrice).toNumber() }
        })
    }, [basket, prices, assetDecimals])
    // console.log("assetValues", assetValues)

    //Group pool values by asset
    const poolValuesByAsset = useMemo(() => {
        if (!poolIDsPerAsset || !totalPoolValues) return []
        return poolIDsPerAsset.map(({ asset_info, pool_IDs }) => {
            const totalValue = pool_IDs.reduce((acc, poolID) => acc + (totalPoolValues[poolID] || 0), 0)
            return { name: (asset_info as any).native_token.denom, value: totalValue }
        })
    }, [poolIDsPerAsset, totalPoolValues])

    // console.log("poolValuesByAsset", poolValuesByAsset)

    //Create health object for each asset using the formula: (assetValue / poolValuesByAsset) * 100
    const healthData = useMemo(() => {
        return assetValues.map(({ name, value }: { name: any; value: number }) => {
            const poolValue = poolValuesByAsset.find((asset) => asset.name === name)?.value
            if (!poolValue) return
            const health = value > poolValue ? 0 : ((poolValue - value) / poolValue) * 100;
            //Cahnge name to symbol
            const symbolName = assetObjects.find((asset) => asset.base === name)?.symbol || name
            return { name: symbolName, health }
        })
    }, [assetValues, poolValuesByAsset, assetObjects])

    // console.log("healthData", healthData)

    return (
        <Stack>
            <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize={TYPOGRAPHY.h3} display="flex" color={SEMANTIC_COLORS.textPrimary}>Oracle Pool Health</Text>
            <Box
                display="grid"
                gridTemplateColumns="repeat(3, 1fr)"
                gap={SPACING.sm}
                bg={SEMANTIC_COLORS.bgPrimary}
                p={SPACING.md}
                border="1px solid"
                borderColor={SEMANTIC_COLORS.borderMedium}
            >
                {healthData.filter((entry: any): entry is { name: any; health: number } => entry !== undefined)
                    .map(({ name, health }: { name: any; health: number }) => (
                        <HealthStatus key={name} health={health} label={name} />
                    ))}

            </Box>
        </Stack>
    )

}