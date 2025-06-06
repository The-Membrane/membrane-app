import React, { useMemo } from 'react';
import { useRouter } from 'next/router';
import { HStack, Box, Spinner, Flex, Text, Image, VStack, Button } from '@chakra-ui/react';
import ManagedMarketInfo from './ManagedMarketInfo';
import ManagedMarketAction from './ManagedMarketAction';
import { useAssetBySymbol } from '@/hooks/useAssets';
import { useManagedConfig, useManagedMarket, useAllMarkets, useMarketCollateralPrice, useMarketCollateralCost } from '@/hooks/useManaged';
import { Formatter } from '@/helpers/formatter';
import { getAssetByDenom } from '@/helpers/chain';
import { shiftDigits } from '@/helpers/math';
import { useBalanceByAsset } from '@/hooks/useBalance';
import ManagePage from './ManagePage';
import { getMarketName } from '@/services/managed';
import useWallet from '@/hooks/useWallet';

const ManagedMarketPage: React.FC = () => {
    const { address } = useWallet();
    const router = useRouter();
    const { marketAddress, action } = router.query;
    //Get chain name from route
    const chainName = router.query.chainName as string;

    // Wait for router to be ready
    if (!router.isReady) {
        return <Spinner size="xl" />;
    }

    // If action is manage, show ManagePage
    if (action === 'manage') {
        return <ManagePage marketAddress={marketAddress as string} />;
    }

    // Extract collateral symbol and action type from action param (if array)
    let collateralSymbol = '';
    let actionType = '';
    if (Array.isArray(action)) {
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
    const { data: priceData, isLoading: priceLoading } = useMarketCollateralPrice(marketAddress as string, asset?.base ?? '');
    const { data: costData, isLoading: costLoading } = useMarketCollateralCost(marketAddress as string, asset?.base ?? '');
    // Fetch contract's balance of the collateral denom
    const contractCollateralBalance = useBalanceByAsset(asset, chainName, marketAddress as string);

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

    // Helper to format price
    const formatPrice = (value: string | number | undefined) => {
        if (value === undefined || value === null || value === '—') return '—';
        return Formatter.currency(Number(value), 4);
    };

    // Derive info card values
    // TVL: contract's balance of the collateral denom * price
    const tvl = useMemo(() => {
        if (
            priceLoading ||
            !priceData?.price ||
            !contractCollateralBalance ||
            contractCollateralBalance === '0' ||
            contractCollateralBalance === '—'
        ) {
            return '—';
        }
        const tvlValue = Number(contractCollateralBalance) * Number(priceData.price);
        return formatNumber(tvlValue);
    }, [priceLoading, priceData, contractCollateralBalance]);
    const suppliedDebt = !configLoading && config?.total_debt_tokens ? formatNumber(shiftDigits(config.total_debt_tokens, -6).toString()) : '—';
    let maxMultiplier = '—';
    // Debug log for params and ltv
    console.log('params', params);
    try {
        console.log('params params', params);
        console.log('collateral params', params?.[0]?.collateral_params);
        console.log('max_borrow_LTV', params?.[0]?.collateral_params?.max_borrow_LTV);
        const ltv = params?.[0]?.collateral_params?.max_borrow_LTV;
        console.log('max_borrow_LTV', ltv);
        if (ltv && !isNaN(Number(ltv)) && Number(ltv) > 0 && Number(ltv) < 1) {
            maxMultiplier = `${(1 / (1 - Number(ltv))).toFixed(2)}x`;
        }
    } catch {}
    const price = !priceLoading && priceData?.price ? formatPrice(priceData.price) : '—';
    const totalSupply = !paramsLoading && params?.[0]?.total_borrowed ? formatNumber(params[0].total_borrowed) : '—';
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
    const interestRateModelProps = tab === 'debt' && params?.[0]?.rate_params ? {
        baseRate: params[0].rate_params.base_rate ?? '—',
        rateMax: params[0].rate_params.rate_max ?? '—',
        kinkMultiplier: params[0].rate_params.rate_kink?.rate_mulitplier ?? '—',
        kinkPoint: params[0].rate_params.rate_kink?.kink_starting_point_ratio ?? '—',
    } : undefined;

    const infoProps = {
        tab: tab as 'collateral' | 'debt',
        tvl,
        suppliedDebt,
        maxMultiplier,
        price,
        totalSupply,
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

    return (
        <HStack align="flex-start" justify="center" spacing={8} w="100%" px={8} py={8}>
            <VStack align="start" w="100%" maxW="420px" minW="320px" spacing={4}>
                {/* Right-aligned header */}
                <Flex w="100%" justify="flex-end" align="center" direction="column" mb={2}>
                    {marketName && (
                        <Text color="whiteAlpha.700" fontWeight="bold" fontSize="md" mb={1} textAlign="right">{marketName}</Text>
                    )}
                    <HStack spacing={3} justify="flex-end">
                        {logo && <Image src={logo} alt={symbol} boxSize="40px" />}
                        <Text color="white" fontWeight="bold" fontSize="2xl">{symbol}</Text>
                    </HStack>
                </Flex>
                <ManagedMarketInfo {...infoProps} />
                {/* If user is the owner, show a button that sends the user to the ManagePage */}
                {config?.owner === address && 
                 <Button 
                    onClick={() => {
                        const asPath = router.asPath;
                        let newPath;
                        if (asPath.endsWith('/manage')) {
                            newPath = asPath;
                        } else if (asPath.match(/\/[^/]+$/)) {
                            // Replace last segment with 'manage'
                            newPath = asPath.replace(/\/[^/]+\/[^/]+$/, '/manage');
                        } else {
                            // Append '/manage'
                            newPath = asPath + '/manage';
                        }
                        router.push(newPath);
                    }}
                >
                    Manage
                </Button>
                }
            </VStack>
            <ManagedMarketAction marketAddress={marketAddress as string} action={actionType} collateralSymbol={collateralSymbol} />
        </HStack>
    );
};

export default ManagedMarketPage; 