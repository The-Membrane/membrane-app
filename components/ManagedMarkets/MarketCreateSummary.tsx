import React from 'react';
import { Box, VStack, HStack, Text } from '@chakra-ui/react';

interface MarketCreateSummaryProps {
    collateralAsset: string;
    maxBorrowLTV: string;
    liquidationLTV: string;
    borrowFee: string;
    managerAddress: string;
    maxSlippage: string | number;
    totalDebtSupplyCap: string;
    osmosisPoolId: string;
    baseRate: string;
    rateMax: string;
    postKinkRateMultiplier: string;
    kinkStartingPointRatio: string;
    enableKink: boolean;
    isWhitelistedManager: boolean;
}

const MarketCreateSummary: React.FC<MarketCreateSummaryProps> = ({
    collateralAsset,
    maxBorrowLTV,
    liquidationLTV,
    borrowFee,
    managerAddress,
    maxSlippage,
    totalDebtSupplyCap,
    osmosisPoolId,
    baseRate,
    rateMax,
    postKinkRateMultiplier,
    kinkStartingPointRatio,
    enableKink,
    isWhitelistedManager,
}) => (
    <Box w="100%" bg="#181C23" borderRadius="lg" p={6} mt={0} mb={2}>
        <Text fontWeight="semibold" mb={2}>Market Summary:</Text>
        <VStack align="stretch" spacing={2} fontSize="sm">
            <HStack justify="space-between">
                <Text color="whiteAlpha.700">Collateral Asset</Text>
                <Text color="white" fontWeight="bold">{collateralAsset}</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color="whiteAlpha.700">Osmosis Pool ID</Text>
                <Text color="white" fontWeight="bold">{osmosisPoolId}</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color="whiteAlpha.700">Max Borrow LTV</Text>
                <Text color="white" fontWeight="bold">{maxBorrowLTV}%</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color="whiteAlpha.700">Liquidation LTV</Text>
                <Text color="white" fontWeight="bold">{liquidationLTV}%</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color="whiteAlpha.700">Borrow Fee</Text>
                <Text color="white" fontWeight="bold">{borrowFee}%</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color="whiteAlpha.700">Manager Address</Text>
                <Text color="white" fontWeight="bold">{managerAddress}</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color="whiteAlpha.700">Max Slippage</Text>
                <Text color="white" fontWeight="bold">{maxSlippage}%</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color="whiteAlpha.700">Total Debt Supply Cap</Text>
                <Text color="white" fontWeight="bold">{totalDebtSupplyCap} CDT</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color="whiteAlpha.700">Interest Rate Model</Text>
                <Text color="white" fontWeight="bold">
                    Base: {baseRate}%
                    {enableKink && (
                        <>
                            | Max: {rateMax}%
                            | Kink: {kinkStartingPointRatio}%
                            | Multiplier: {postKinkRateMultiplier}x
                        </>
                    )}
                </Text>
            </HStack>
        </VStack>
        {/* Non-whitelisted manager notice */}
        {!isWhitelistedManager && (
            <Text color="blue.300" fontWeight="bold" mt={6} textAlign="center">
                Non-whitelisted Managers pay 25 CDT that is supplied to the market
            </Text>
        )}
    </Box>
);

export default MarketCreateSummary; 