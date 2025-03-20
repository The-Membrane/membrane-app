import { useBasket } from '@/hooks/useCDP';
import React, { useMemo, useState } from 'react';
import { AssetInfo, AssetResponse } from '@/contracts/codegen/oracle/Oracle.types'
import { useOracleAssetInfos, useOracleConfig, useOraclePrice } from '@/hooks/useOracle';
import { PoolLiquidityData, usePoolLiquidity } from '@/hooks/useOsmosis';
import { Price } from '@/services/oracle';
import { getAssetByDenom, getAssetsByDenom } from '@/helpers/chain';
import { shiftDigits } from '@/helpers/math';
import { Box, Text, Circle, Tooltip, Stack, HStack, Slider, SliderFilledTrack, SliderMark, SliderTrack } from "@chakra-ui/react";
import { colors } from '@/config/defaults';
import { getAssetRatio, getTVL, Positions } from '@/services/cdp';
import { num } from '@/helpers/num';

const CapStatus = ({ ratio = 0, cap = 0, health = 100, label = "N/A" }) => {
    // Calculate color based on health value
    const getBarColor = () => {
        if (ratio >= cap) return "red.400";
        return colors.sliderFilledTrack;
    };

    // console.log(ratio)


    return (
        <HStack>
            <Text color="whiteAlpha.700">{label}</Text>

            <Slider
                defaultValue={ratio}
                isReadOnly
                cursor="default"
                min={0}
                max={1}
                value={ratio}
            >
                <SliderTrack h="1.5">
                    <SliderFilledTrack bg={getBarColor()} />
                </SliderTrack>
                <SliderMark value={cap}>
                    <Box bg="white" w="0.5" h="4" mt="-2" />
                </SliderMark>
            </Slider>
        </HStack>
    );
};

// function transformAssets(assets: AssetResponse[]): { asset_info: AssetInfo; pool_IDs: number[] }[] {
//     return assets.map(({ asset_info, oracle_info }) => {
//         // Create pool_IDs from the oracle_info
//         const pool_IDs = oracle_info.flatMap(({ lp_pool_info, pools_for_osmo_twap }) => [
//             ...(lp_pool_info ? [lp_pool_info.pool_id] : []),
//             ...pools_for_osmo_twap.map(pool => pool.pool_id),
//         ]);

//         // Check if asset_info is of type native_token with denom 'usomo'
//         if ('native_token' in asset_info && asset_info.native_token.denom === 'usomo') {
//             // Manually add pool ID for 'usomo'
//             pool_IDs.push(678);
//         }

//         // Return transformed object
//         return { asset_info, pool_IDs };
//     });
// }


// export type PoolTotalValueMap = Record<string, number>; // { poolId: totalValue }

// function calculateTotalPoolValues(
//     poolLiquidityData: PoolLiquidityData[],
//     prices: Price[],
//     assetDecimals: { decimal: number; denom: string }[]
// ): PoolTotalValueMap {
//     // Convert prices array into a lookup map { denom: price }
//     const priceMap = new Map(prices.map(({ denom, price }) => [denom, Number(price)]));

//     return poolLiquidityData.reduce<PoolTotalValueMap>((acc, { poolId, liquidity }) => {
//         let totalValue = 0;

//         for (const asset of liquidity.liquidity) {
//             // console.log("asset", poolId, asset)
//             const assetPrice = priceMap.get(asset.denom) || 0;
//             const assetDecimal = assetDecimals.find(({ denom }) => denom === asset.denom)?.decimal || 6;
//             const assetAmount = shiftDigits(asset.amount, -assetDecimal);
//             totalValue += assetAmount.times(assetPrice).toNumber();
//         }

//         acc[poolId] = totalValue;
//         return acc;
//     }, {});
// }

export const SupplyCaps = () => {
    //We'll forego using the config to get the OSMO pool ID for now, and just hardcode it
    // const { data: config } = useOracleConfig()
    const { data: prices } = useOraclePrice()
    const { data: basket } = useBasket()
    // const usedAssets = useMemo(() => {
    //     if (!basket) return []
    //     return basket.collateral_supply_caps
    //         .filter((cap) => Number(cap.supply_cap_ratio) > 0)
    //         //@ts-ignore
    //         .map((cap) => (cap.asset_info as AssetInfo),  // Directly assign if you're sure it's always a native_token
    //         );
    // }, [basket])
    // //@ts-ignore
    // const usedDenoms = usedAssets.map((asset) => asset.native_token.denom)
    // const assetObjects = getAssetsByDenom(usedDenoms)
    // const assetDecimals = assetObjects.map((asset) => ({ decimal: asset.decimal || 6, denom: asset.base }))
    // // console.log("usedAssets", usedAssets)
    // const { data: assetInfos } = useOracleAssetInfos(usedAssets)
    // // console.log("assetInfos", assetInfos)
    // //Get pool IDS for each asset
    // const poolIDsPerAsset = useMemo(() => {
    //     if (!assetInfos) return []
    //     return transformAssets(assetInfos)
    // }, [assetInfos])
    // const poolIDs = poolIDsPerAsset.flatMap(({ pool_IDs }) => pool_IDs.toString())
    // // console.log("poolIDsPerAsset", poolIDsPerAsset)

    // //Query pool liquidity for each pool
    // const poolData = usePoolLiquidity(poolIDs)
    // const poolLiquidityData = useMemo(() => {
    //     return poolData
    //         .map(query => query.data) // Extract only the `data` property
    //         .filter((data): data is PoolLiquidityData => data !== undefined); // Remove undefined results
    // }, [poolData]);
    // // console.log("poolLiquidityData", poolLiquidityData)


    // //Create a map of pool ID to liquidity value
    // const totalPoolValues = useMemo(() => {
    //     if (!prices || !poolLiquidityData) return {}
    //     return calculateTotalPoolValues(poolLiquidityData, prices, assetDecimals)
    // }, [prices, poolLiquidityData, assetDecimals])
    // // console.log("totalPoolValues", totalPoolValues)

    // //Calculate the value of usedAssets in USD using basket.collateral_supply_caps.current_supply * price
    // const assetValues = useMemo(() => {
    //     if (!basket || !prices) return []
    //     return basket.collateral_supply_caps.map((cap) => {
    //         const assetPrice = prices.find((price) => price.denom === cap.asset_info.native_token.denom)?.price || 0
    //         const assetDecimal = assetDecimals.find(({ denom }) => denom === cap.asset_info.native_token.denom)?.decimal || 6;
    //         const assetAmount = shiftDigits(cap.current_supply, -assetDecimal);
    //         return { name: cap.asset_info.native_token.denom, value: assetAmount.times(assetPrice).toNumber() }
    //     })
    // }, [basket, prices])
    // // console.log("assetValues", assetValues)

    // //Group pool values by asset
    // const poolValuesByAsset = useMemo(() => {
    //     if (!poolIDsPerAsset || !totalPoolValues) return []
    //     return poolIDsPerAsset.map(({ asset_info, pool_IDs }) => {
    //         const totalValue = pool_IDs.reduce((acc, poolID) => acc + (totalPoolValues[poolID] || 0), 0)
    //         return { name: asset_info.native_token.denom, value: totalValue }
    //     })
    // }, [poolIDsPerAsset, totalPoolValues])

    // console.log("poolValuesByAsset", poolValuesByAsset)

    //Create health object for each asset using the formula: (assetValue / poolValuesByAsset) * 100
    const capData = useMemo(() => {
        const basketPositions = basket?.collateral_types.map((asset) => {
            //@ts-ignore
            const denom = asset.asset.info.native_token.denom
            const assetInfo = getAssetByDenom(denom)
            const amount = shiftDigits(asset.asset.amount, -(assetInfo?.decimal ?? 6)).toNumber()
            const assetPrice = prices?.find((price) => price.denom === denom)?.price || 0

            console.log(assetInfo?.symbol, amount, assetPrice)

            const usdValue = num(amount).times(assetPrice).toNumber()
            return {
                ...assetInfo,
                denom,
                amount,
                assetPrice,
                usdValue,
            }
        }) as Positions[]

        const tvl = getTVL(basketPositions)

        const positionsWithRatio = getAssetRatio(false, tvl, basketPositions)

        return positionsWithRatio.map((position, index) => {
            return { name: position?.symbol ?? "N/A", ratio: position?.ratio ?? 0, cap: basket?.collateral_supply_caps[index].supply_cap_ratio ?? "0" }
        })

    }, [basket?.collateral_supply_caps, prices])

    console.log("capData", capData)

    return (
        <Stack width="59%">
            <Text fontWeight="bold" fontFamily="Inter" fontSize={"xl"} letterSpacing={"1px"} display="flex" color={colors.earnText}>Supply Caps</Text>
            <div style={{
                display: "grid", gridTemplateColumns: "repeat(3, 1fr)", gap: "0.5rem",
                backgroundColor: colors.globalBG, // Color the gaps
                padding: "10px", // Ensures outer gaps are also colored
                border: "2px solid white",
            }}>
                {capData.map((data) => (
                    <CapStatus key={data.name} ratio={data.ratio} cap={Number(data.cap)} label={data.name} />
                ))}

            </div>
        </Stack>
    )

}