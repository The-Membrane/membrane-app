import React, { useMemo } from 'react';
import { useRouter } from 'next/router';
import { HStack, Box, Spinner, Flex, Text, Image, VStack } from '@chakra-ui/react';
import ManagedMarketInfo from './ManagedMarketInfo';
import ManagedMarketAction from './ManagedMarketAction';
import { useAssetBySymbol } from '@/hooks/useAssets';
import { useManagedConfig, useManagedMarket, useAllMarkets, useMarketCollateralPrice, useMarketCollateralCost } from '@/hooks/useManaged';
import { Formatter } from '@/helpers/formatter';
import { getAssetByDenom } from '@/helpers/chain';

const ManagedMarketPage: React.FC = () => {
    const router = useRouter();
    const { marketAddress: address, action } = router.query;
    //Get chain name from route
    const chainName = router.query.chainName as string;

    // Wait for router to be ready
    if (!router.isReady) {
        return <Spinner size="xl" />;
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
    // Memoize allMarkets and marketName
    const allMarkets = useAllMarkets();
    const marketName = useMemo(() => {
        if (allMarkets && address) {
            const found = allMarkets.find((m: any) => m.address === address);
            if (found) return found.name;
        }
        return 'Unnamed Market';
    }, [allMarkets, address]);

    // Determine tab type from actionType (default to 'collateral')
    const tab = actionType === 'lend' ? 'debt' : 'collateral';

    console.log('asset', asset);
    // Fetch market data
    const { data: config, isLoading: configLoading } = useManagedConfig(address as string);
    const { data: params, isLoading: paramsLoading } = useManagedMarket(address as string, asset?.base ?? '');
    const { data: priceData, isLoading: priceLoading } = useMarketCollateralPrice(address as string, asset?.base ?? '');
    const { data: costData, isLoading: costLoading } = useMarketCollateralCost(address as string, asset?.base ?? '');

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
    const tvl = !paramsLoading && params?.total_borrowed ? formatNumber(params.total_borrowed) : '—';
    const suppliedDebt = !configLoading && config?.total_debt_tokens ? formatNumber(config.total_debt_tokens) : '—';
    let maxMultiplier = '—';
    // Debug log for params and ltv
    console.log('params', params);
    try {
        const ltv = params?.collateral_params?.max_borrow_LTV;
        console.log('max_borrow_LTV', ltv);
        if (ltv && !isNaN(Number(ltv)) && Number(ltv) > 0 && Number(ltv) < 1) {
            maxMultiplier = `${(1 / (1 - Number(ltv))).toFixed(2)}x`;
        }
    } catch {}
    const price = !priceLoading && priceData?.price ? formatPrice(priceData.price) : '—';
    const totalSupply = !paramsLoading && params?.total_borrowed ? formatNumber(params.total_borrowed) : '—';
    const borrowCost = !costLoading && costData ? formatPercent(costData) : '—';
    // These may need more specific queries:
    const totalDebt = !configLoading && config?.total_debt_tokens ? formatNumber(config.total_debt_tokens) : '—';
    const borrowAPY = borrowCost;
    const maxCollateralLiquidatibility = params?.borrow_cap?.cap_borrows_by_liquidity ? 'Yes' : 'No';
    // Oracles: extract from params.pool_for_oracle_and_liquidations
    const oracles = [];
    if (params?.pool_for_oracle_and_liquidations) {
        const oracleInfo = params.pool_for_oracle_and_liquidations;
        const pools = oracleInfo.pools_for_osmo_twap || [];
        for (let i = 0; i < pools.length; i++) {
            const pool = pools[i];
            const isLast = i === pools.length - 1;
            // Always show base asset logo
            const baseAsset = getAssetByDenom(pool.base_asset_denom, chainName);
            oracles.push({
                name: baseAsset?.symbol || pool.base_asset_denom,
                logo: baseAsset?.logo || '',
                address: pool.base_asset_denom,
            });
            // If last pool, also show quote asset logo
            if (isLast) {
                const quoteAsset = getAssetByDenom(pool.quote_asset_denom, chainName);
                oracles.push({
                    name: quoteAsset?.symbol || pool.quote_asset_denom,
                    logo: quoteAsset?.logo || '',
                    address: pool.quote_asset_denom,
                });
            }
        }
    }
    // Interest Rate Model
    const interestRateModelProps = tab === 'debt' && params?.rate_params ? {
        baseRate: params.rate_params.base_rate ?? '—',
        rateMax: params.rate_params.rate_max ?? '—',
        kinkMultiplier: params.rate_params.rate_kink?.rate_mulitplier ?? '—',
        kinkPoint: params.rate_params.rate_kink?.kink_starting_point_ratio ?? '—',
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
        address: address as string || '—',
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
            </VStack>
            <ManagedMarketAction marketAddress={address as string} action={actionType} collateralSymbol={collateralSymbol} />
        </HStack>
    );
};

export default ManagedMarketPage; 