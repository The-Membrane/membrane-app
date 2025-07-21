import React, { useMemo, useState, useEffect } from 'react';
import { useRouter } from 'next/router';
import { HStack, Box, Spinner, Flex, Text, Image, VStack, Button, Switch, FormControl, FormLabel, Stack } from '@chakra-ui/react';
import ManagedMarketInfo from './ManagedMarketInfo';
import ManagedMarketAction from './ManagedMarketAction';
import { useAssetBySymbol } from '@/hooks/useAssets';
import { useManagedConfig, useManagedMarket, useAllMarkets, useMarketCollateralPrice, useMarketCollateralCost, useTotalBorrowed } from '@/hooks/useManaged';
import { Formatter } from '@/helpers/formatter';
import { Asset, getAssetByDenom } from '@/helpers/chain';
import { shiftDigits } from '@/helpers/math';
import { useBalanceByAsset } from '@/hooks/useBalance';
import ManagePage from './ManagePage';
import { getMarketName } from '@/services/managed';
import useWallet from '@/hooks/useWallet';
import { num } from '@/helpers/num';
import IncreaseExposureCards from './IncreaseExposureCards';
// @ts-ignore
import { FastAverageColor } from 'fast-average-color';



    // Helper to format price
    export const formatPrice = (value: string | number | undefined) => {
        if (value === undefined || value === null || value === '—') return '—';
        return Formatter.currency(Number(value), 4);
    };

const ManagedMarketPage: React.FC = () => {
    const router = useRouter();
    // Wait for router to be ready BEFORE any hooks
    if (!router.isReady) {
        return <Spinner size="xl" />;
    }
    const { address } = useWallet();
    const { marketAddress, action, symbol: symbolParam } = router.query;
    //Get chain name from route
    const chainName = router.query.chainName as string;

    // Extract collateral symbol and action type
    let collateralSymbol = '';
    let actionType = '';
    if (symbolParam) {
        // If symbol is present in the route, use it
        collateralSymbol = Array.isArray(symbolParam) ? symbolParam[0] : symbolParam;
        actionType = typeof action === 'string' ? action : '';
    } else if (Array.isArray(action)) {
        collateralSymbol = action[0] || '';
        actionType = action[1] || '';
    } else if (typeof action === 'string') {
        collateralSymbol = action;
        actionType = action;
    }

    // Get asset info for header
    const asset = useAssetBySymbol(collateralSymbol, chainName);
    const logo = asset?.logo || '';
    const symbol = asset?.symbol || collateralSymbol;
    // Get market name
    const marketName = getMarketName(marketAddress as string);

    // Determine tab type from actionType (default to 'collateral')
    const tab = actionType === 'lend' ? 'debt' : 'collateral';

    console.log('asset', asset);
    // Fetch market data
    const { data: config, isLoading: configLoading } = useManagedConfig(marketAddress as string);
    const { data: params, isLoading: paramsLoading } = useManagedMarket(marketAddress as string, asset?.base ?? '');
    const { data: totalBorrowed, isLoading: totalBorrowedLoading } = useTotalBorrowed(marketAddress as string);
    const { data: priceData, isLoading: priceLoading } = useMarketCollateralPrice(marketAddress as string, asset?.base ?? '');
    const { data: costData, isLoading: costLoading } = useMarketCollateralCost(marketAddress as string, asset?.base ?? '');
    // Fetch contract's balance of the collateral denom
    const contractCollateralBalance = useBalanceByAsset(asset, chainName, marketAddress as string);
    // Fetch user's balance of the asset
    const userBalance = useBalanceByAsset(asset, chainName, address);
    // Fetch price of the asset
    const assetPrice = priceData?.price || '0';


    // Format numbers using Formatter.tvlShort
    const formatNumber = (value: string | number | undefined) => {
        if (value === undefined || value === null || value === '—') return '—';
        if (typeof value === 'string' && value.match(/[^0-9.]/)) return value;
        return Formatter.tvlShort(Number(value));
    };

    // Helper to format percent
    const formatPercent = (value: string | number | undefined) => {
        if (value === undefined || value === null || value === '—') return '—';
        return Formatter.percent(Number(value) * 100, 2); // expects 0.05 for 5%
    };

    // Derive info card values
    // TVL: contract's balance of the collateral denom * price
    const tvl = useMemo(() => {
        if (
            priceLoading ||
            !assetPrice ||
            !contractCollateralBalance ||
            contractCollateralBalance === '0' ||
            contractCollateralBalance === '—' ||
            totalBorrowedLoading
        ) {
            return '—';
        }
        const tvlValue = Number(contractCollateralBalance) * Number(assetPrice);
        return formatNumber(tvlValue);
    }, [priceLoading, assetPrice, contractCollateralBalance, totalBorrowedLoading]);
    
    const suppliedDebt = !configLoading && config?.total_debt_tokens ? formatNumber(shiftDigits(config.total_debt_tokens, -6).toString()) : '—';
    let maxMultiplier = '—';
    let maxLTV = '—';
    let maxBorrowLTV;
    // Debug log for params and ltv
    // console.log('params', params);
    try {
        // console.log('params params', params);
        // console.log('collateral params', params?.[0]?.collateral_params);
        // console.log('max_borrow_LTV', params?.[0]?.collateral_params?.max_borrow_LTV);
        maxBorrowLTV = params?.[0]?.collateral_params?.max_borrow_LTV;
        maxLTV = params?.[0]?.collateral_params?.liquidation_LTV ?? '—';
        // console.log('max_borrow_LTV', ltv);
        if (maxBorrowLTV && !isNaN(Number(maxBorrowLTV)) && Number(maxBorrowLTV) > 0 && Number(maxBorrowLTV) < 1) {
            maxMultiplier = `${(1 / (1 - Number(maxBorrowLTV))).toFixed(2)}x`;
        }
    } catch {}
    const price = !priceLoading && priceData?.price ? formatPrice(priceData.price) : '—';
    const availableLiquidity = num(suppliedDebt).minus(shiftDigits(totalBorrowed ?? "0", -6)).toFixed(2)
    // !paramsLoading && params?.[0]?.total_borrowed ? formatNumber(params[0].total_borrowed) : '—';
    const borrowCost = !costLoading && costData ? formatPercent(costData) : '—';
    // These may need more specific queries:
    const totalDebt = !configLoading && config?.total_debt_tokens ? formatNumber(config.total_debt_tokens) : '—';
    const borrowAPY = borrowCost;
    const maxCollateralLiquidatibility = params?.[0]?.borrow_cap?.cap_borrows_by_liquidity ? 'Yes' : 'No';
    // Oracles: extract from params.pool_for_oracle_and_liquidations
    const oracles = [];
    if (params?.[0]?.pool_for_oracle_and_liquidations) {
        const oracleInfo = params[0].pool_for_oracle_and_liquidations;
        const pools = oracleInfo.pools_for_osmo_twap || [];
        console.log('pools', oracleInfo, pools);
        for (let i = 0; i < pools.length; i++) {
            const pool = pools[i];
            const isLast = i === pools.length - 1;
            // Always show base asset logo
            const baseAsset = getAssetByDenom(pool.base_asset_denom, chainName);
            oracles.push({
                name: baseAsset?.symbol || pool.base_asset_denom,
                logo: baseAsset?.logo || '',
                poolId: pool.pool_id,
            });
            // If last pool, also show quote asset logo
            if (isLast) {
                const quoteAsset = getAssetByDenom(pool.quote_asset_denom, chainName);
                oracles.push({
                    name: quoteAsset?.symbol || pool.quote_asset_denom,
                    logo: quoteAsset?.logo || '',
                    poolId: pool.pool_id,
                });
            }
        }
    }
    // console.log('oracles', oracles);
    // Interest Rate Model
    let currentRatio: number | undefined = undefined;
    if (totalBorrowed && config?.total_debt_tokens && !isNaN(Number(totalBorrowed)) && !isNaN(Number(config.total_debt_tokens)) && Number(config.total_debt_tokens) > 0) {
        currentRatio = Number(totalBorrowed) / Number(config.total_debt_tokens);
    }
    const interestRateModelProps = params?.[0]?.rate_params ? {
        baseRate: params[0].rate_params.base_rate ?? '—',
        rateMax: params[0].rate_params.rate_max ?? '—',
        kinkMultiplier: params[0].rate_params.rate_kink?.rate_mulitplier ?? '',
        kinkPoint: params[0].rate_params.rate_kink?.kink_starting_point_ratio ?? '—',
        currentRatio,
        showTitle: true,
    } : undefined;

    const infoProps = {
        tab: tab as 'collateral' | 'debt',
        tvl,
        suppliedDebt,
        maxMultiplier,
        price,
        availableLiquidity,
        borrowCost,
        totalDebt,
        borrowAPY,
        maxCollateralLiquidatibility,
        oracles,
        marketAddress: marketAddress as string,
        owner: config?.owner,
        interestRateModelProps,
        logo,
        symbol,
        marketName,
    };

    const [advancedMode, setAdvancedMode] = useState(false);
    const [glowColor, setGlowColor] = useState<string | undefined>(undefined);
    useEffect(() => {
        if (!logo) return;
        const fac = new FastAverageColor();
        const img = new window.Image();
        img.crossOrigin = 'anonymous';
        img.src = logo;
        img.onload = () => {
            const color = fac.getColor(img);
            setGlowColor(color.hex);
        };
        img.onerror = () => setGlowColor(undefined);
        // Cleanup
        return () => fac.destroy();
    }, [logo]);

    // Only after all hooks, do conditional rendering:
    if (action === 'manage') {
        return <ManagePage marketAddress={marketAddress as string} />;
    }

    return (
        <Box position="relative" w="100%" h="100%">
            {/* Advanced mode toggle in the absolute top left corner */}
            <Box
                position={{ base: 'static', lg: 'absolute' }}
                top={{ lg: 4 }}
                left={{ lg: 4 }}
                zIndex={10}
                alignSelf={{ base: 'center', lg: 'flex-start' }}
                my={{ base: 4, lg: 0 }}
            >
                <FormControl display="flex" alignItems="center" justifyContent={{ base: 'center', lg: undefined }}>
                    <FormLabel htmlFor="advanced-mode-toggle" mb="0" fontWeight="bold" color="white">
                        Advanced mode
                    </FormLabel>
                    <Switch
                        id="advanced-mode-toggle"
                        isChecked={advancedMode}
                        onChange={() => setAdvancedMode((v) => !v)}
                    />
                </FormControl>
            </Box>
            <Stack direction={{ base: 'column', lg: 'row' }} align="flex-start" justify="center" spacing={{ base: 6, lg: 4 }} w="100%" px={{ base: 4, lg: 8 }} py={{ base: 6, lg: 8 }}>
                <VStack align="start" w="100%" maxW={advancedMode ? "480px" : "630px"} spacing={6}>
                    {advancedMode ? (
                        <>
                            <Flex w="100%" justify="flex-end" align="center" direction="column" mb={2}>
                                {marketName && (
                                    <Text color="whiteAlpha.700" fontWeight="bold" fontSize="md" mb={1} textAlign="right">{marketName}</Text>
                                )}
                                <HStack spacing={3} justify="flex-end">
                                    {logo && <Image src={logo} alt={symbol} boxSize="60px" />}
                                    <Text color="white" fontWeight="bold" fontSize="3xl">{symbol}</Text>
                                </HStack>
                            </Flex>
                            <ManagedMarketInfo {...infoProps} />
                        </>
                    ) : (
                        <IncreaseExposureCards 
                            logo={logo} 
                            symbol={symbol} 
                            large 
                            glowColor={glowColor} 
                            balance={userBalance} 
                            price={assetPrice} 
                            maxLTV={maxLTV} 
                            maxBorrowLTV={maxBorrowLTV ? Number(maxBorrowLTV) : undefined}
                            marketContract={marketAddress as string} 
                            asset={asset as Asset} 
                        />
                    )}
                    {advancedMode && config?.owner === address &&
                        <Button
                            onClick={() => {
                                const asPath = router.asPath;
                                // Remove query string if present
                                const pathWithoutQuery = asPath.includes('?') ? asPath.slice(0, asPath.indexOf('?')) : asPath;
                                let newPath;
                                if (pathWithoutQuery.endsWith('/manage')) {
                                    newPath = pathWithoutQuery;
                                } else {
                                    newPath = pathWithoutQuery + '/manage';
                                }
                                router.push(newPath);
                            }}
                        >
                            Manage
                        </Button>
                    }
                </VStack>
                {advancedMode && (
                    <ManagedMarketAction marketAddress={marketAddress as string} action={actionType} collateralSymbol={collateralSymbol} />
                )}
            </Stack>
        </Box>
    );
};

export default ManagedMarketPage; 