import React from 'react';
import { useRouter } from 'next/router';
import { HStack, Box, Spinner } from '@chakra-ui/react';
import ManagedMarketInfo from './ManagedMarketInfo';
import ManagedMarketAction from './ManagedMarketAction';

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

    // Determine tab type from actionType (default to 'collateral')
    const tab = actionType === 'lend' ? 'debt' : 'collateral';

    // Placeholder data for info card (replace with real data as available)
    const infoProps = {
        tab: tab as 'collateral' | 'debt',
        tvl: '—',
        suppliedDebt: '—',
        maxMultiplier: '—',
        price: '—',
        totalSupply: '—',
        supplyAPY: '—',
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
    };

    return (
        <HStack align="flex-start" justify="center" spacing={2} w="100%" px={8} py={8}>
            <ManagedMarketInfo {...infoProps} />
            <ManagedMarketAction marketAddress={address as string} action={actionType} collateralSymbol={collateralSymbol} />
        </HStack>
    );
};

export default ManagedMarketPage; 