import React from 'react';
import { Box, VStack, HStack, Text } from '@chakra-ui/react';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

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
    <Box w="100%" bg={SEMANTIC_COLORS.bgTertiary} borderRadius={0} p={6} mt={0} mb={2}>
        <Text fontWeight="semibold" mb={2}>Market Summary:</Text>
        <VStack align="stretch" spacing={2} fontSize="sm">
            <HStack justify="space-between">
                <Text color={SEMANTIC_COLORS.textSecondary}>Collateral Asset</Text>
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{collateralAsset}</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color={SEMANTIC_COLORS.textSecondary}>Osmosis Pool ID</Text>
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{osmosisPoolId}</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color={SEMANTIC_COLORS.textSecondary}>Max Borrow LTV</Text>
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{maxBorrowLTV}%</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color={SEMANTIC_COLORS.textSecondary}>Liquidation LTV</Text>
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{liquidationLTV}%</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color={SEMANTIC_COLORS.textSecondary}>Borrow Fee</Text>
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{borrowFee}%</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color={SEMANTIC_COLORS.textSecondary}>Manager Address</Text>
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{managerAddress}</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color={SEMANTIC_COLORS.textSecondary}>Max Slippage</Text>
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{maxSlippage}%</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color={SEMANTIC_COLORS.textSecondary}>Total Debt Supply Cap</Text>
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">{totalDebtSupplyCap} CDT</Text>
            </HStack>
            <HStack justify="space-between">
                <Text color={SEMANTIC_COLORS.textSecondary}>Interest Rate Model</Text>
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight="bold">
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
            <Text color={SEMANTIC_COLORS.warning} fontWeight="bold" mt={6} textAlign="center">
                Non-whitelisted Managers pay 25 CDT that is supplied to the market
            </Text>
        )}
    </Box>
);

export default MarketCreateSummary; 