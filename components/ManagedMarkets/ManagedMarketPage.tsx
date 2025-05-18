import React from 'react';
import { useRouter } from 'next/router';
import { HStack, Box, Spinner } from '@chakra-ui/react';
import ManagedMarketInfo from './ManagedMarketInfo';
import ManagedMarketAction from './ManagedMarketAction';

const ManagedMarketPage: React.FC = () => {
    const router = useRouter();
    const { address, action } = router.query;

    // Wait for router to be ready
    if (!router.isReady) {
        return <Spinner size="xl" />;
    }

    // Determine tab type from action (default to 'collateral')
    const tab = action === 'debt' ? 'debt' : 'collateral';

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
        <HStack align="flex-start" spacing={2} w="100%" px={8} py={8}>
            <Box flex={1} maxW="480px">
                <ManagedMarketInfo {...infoProps} />
            </Box>
            <Box flex={2} w="100%">
                <ManagedMarketAction marketAddress={address as string} action={action as string} />
            </Box>
        </HStack>
    );
};

export default ManagedMarketPage; 