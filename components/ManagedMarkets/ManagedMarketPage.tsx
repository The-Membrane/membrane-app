import React, { useMemo } from 'react';
import { useRouter } from 'next/router';
import { HStack, Box, Spinner, Flex, Text, Image, VStack } from '@chakra-ui/react';
import ManagedMarketInfo from './ManagedMarketInfo';
import ManagedMarketAction from './ManagedMarketAction';
import { useAssetBySymbol } from '@/hooks/useAssets';
import { useManagedConfig, useManagedMarket, useAllMarkets } from '@/hooks/useManaged';
import { Formatter } from '@/helpers/formatter';

const ManagedMarketPage: React.FC = () => {
    const router = useRouter();
    const { marketAddress: address, action } = router.query;

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
    const asset = useAssetBySymbol(collateralSymbol, 'osmosis');
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

    // Format numbers using Formatter.tvlShort
    const formatNumber = (value: string) => {
        const num = parseFloat(value.replace(/[^0-9.]/g, ''));
        return Formatter.tvlShort(num);
    };

    // Placeholder data for info card (replace with real data as available)
    const infoProps = {
        tab: tab as 'collateral' | 'debt',
        tvl: formatNumber('573000000'),
        suppliedDebt: formatNumber('32000000'),
        maxMultiplier: '3.03x',
        price: '$0.23',
        totalSupply: formatNumber('751000000'),
        borrowCost: '5%',
        totalDebt: '—',
        borrowAPY: '—',
        maxCollateralLiquidatibility: '—',
        oracles: [],
        address: address as string || '—',
        interestRateModelProps: tab === 'debt' ? {
            baseRate: '—',
            rateMax: '—',
            kinkMultiplier: '—',
            kinkPoint: '—',
        } : undefined,
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