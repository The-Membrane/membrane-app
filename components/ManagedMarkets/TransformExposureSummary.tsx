import React from 'react';
import { Box, VStack, HStack, Text, Badge, Divider } from '@chakra-ui/react';
import { Asset } from '@/helpers/chain';
import { num } from '@/helpers/num';
import { shiftDigits } from '@/helpers/math';
import BigNumber from 'bignumber.js';
import { m } from 'framer-motion';
import { Formatter } from '@/helpers/formatter';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

interface TransformExposureSummaryProps {
  mode: 'multiply' | 'de-risk';
  asset: Asset;
  collateralAmount: string;
  multiplier: number;
  borrowAmount: string;
  collateralValue: number;
  maxBorrowLTV: number;
}

const TransformExposureSummary: React.FC<TransformExposureSummaryProps> = ({
  mode,
  asset,
  collateralAmount,
  multiplier,
  borrowAmount,
  collateralValue,
  maxBorrowLTV,
}) => {
  // Calculate derived values
  const loopLTV = Math.min(1 - 1 / multiplier, maxBorrowLTV);
  const collateralAmountFormatted = Formatter.toNearestNonZero(collateralAmount, asset.decimal);
  const borrowAmountFormatted = Formatter.toNearestNonZero(borrowAmount);

  return (
    <Box
      w="100%"
      bg={SEMANTIC_COLORS.bgTertiary}
      borderRadius={0}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p={SPACING.lg}
      mt={0}
      mb={SPACING.sm}
    >
      <VStack align="stretch" spacing={SPACING.base}>
        {/* Header */}
        <Box>
          <HStack justify="space-between" mb={SPACING.sm}>
            <Text
              fontFamily={TYPOGRAPHY.fontDisplay}
              fontSize={TYPOGRAPHY.h3}
              fontWeight={TYPOGRAPHY.semibold}
              color={SEMANTIC_COLORS.textPrimary}
            >
              Transform Exposure Summary
            </Text>
            <Badge
              variant="outline"
              borderRadius={0}
              bg="transparent"
              boxShadow="none"
              border="1px solid"
              borderColor={mode === 'multiply' ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning}
              color={mode === 'multiply' ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.label}
              textTransform="uppercase"
              letterSpacing="0.28em"
              px={SPACING.sm}
            >
              {mode === 'multiply' ? 'MULTIPLY' : 'DE-RISK'}
            </Badge>
          </HStack>
          <Text
            color={SEMANTIC_COLORS.textSecondary}
            fontSize={TYPOGRAPHY.small}
            fontFamily={TYPOGRAPHY.fontMono}
          >
            {mode === 'multiply'
              ? 'Increase your exposure through looping strategy'
              : 'Reduce your exposure by borrowing against collateral'
            }
          </Text>
        </Box>

        <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

        {/* Collateral Details */}
        <Box>
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h4}
            fontWeight={TYPOGRAPHY.semibold}
            mb={SPACING.md}
            color={SEMANTIC_COLORS.textPrimary}
          >
            Collateral Details
          </Text>
          <VStack align="stretch" spacing={SPACING.sm} fontSize={TYPOGRAPHY.small} fontFamily={TYPOGRAPHY.fontMono}>
            <HStack justify="space-between">
              <Text color={SEMANTIC_COLORS.textSecondary}>Asset</Text>
              <Text color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.bold}>{asset.symbol}</Text>
            </HStack>
            <HStack justify="space-between">
              <Text color={SEMANTIC_COLORS.textSecondary}>Collateral Amount</Text>
              <Text color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {collateralAmountFormatted} {asset.symbol}
              </Text>
            </HStack>
            <HStack justify="space-between">
              <Text color={SEMANTIC_COLORS.textSecondary}>Collateral Value</Text>
              <Text color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>${collateralValue.toFixed(2)}</Text>
            </HStack>
          </VStack>
        </Box>

        <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

        {/* Strategy Details */}
        <Box>
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h4}
            fontWeight={TYPOGRAPHY.semibold}
            mb={SPACING.md}
            color={SEMANTIC_COLORS.textPrimary}
          >
            Strategy Details
          </Text>
          <VStack align="stretch" spacing={SPACING.sm} fontSize={TYPOGRAPHY.small} fontFamily={TYPOGRAPHY.fontMono}>

           {mode === 'multiply' && (
            <HStack justify="space-between">
              <Text color={SEMANTIC_COLORS.textSecondary}>Multiplier</Text>
              <Text color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>{multiplier.toFixed(2)}x</Text>
            </HStack>
           )}
            {mode === 'de-risk' && (
              <HStack justify="space-between">
                <Text color={SEMANTIC_COLORS.textSecondary}>Borrow Amount</Text>
                <Text color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.bold} sx={{ fontVariantNumeric: 'tabular-nums' }}>
                  {borrowAmountFormatted} CDT
                </Text>
              </HStack>
            )}
          </VStack>
        </Box>

        <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />


        <Divider borderColor={SEMANTIC_COLORS.borderSubtle} />

        {/* Actions to be Performed */}
        <Box>
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h4}
            fontWeight={TYPOGRAPHY.semibold}
            mb={SPACING.md}
            color={SEMANTIC_COLORS.textPrimary}
          >
            Actions to be Performed
          </Text>
          <VStack align="stretch" spacing={SPACING.sm} fontSize={TYPOGRAPHY.small} fontFamily={TYPOGRAPHY.fontMono}>
            <HStack>
              <Text color={SEMANTIC_COLORS.success} fontSize={TYPOGRAPHY.body}>✓</Text>
              <Text color={SEMANTIC_COLORS.textSecondary} sx={{ fontVariantNumeric: 'tabular-nums' }}>Deposit {collateralAmountFormatted} {asset.symbol}</Text>
            </HStack>

            {mode === 'multiply' ? (
              <>
                <HStack>
                  <Text color={SEMANTIC_COLORS.success} fontSize={TYPOGRAPHY.body}>✓</Text>
                  <Text color={SEMANTIC_COLORS.textSecondary} sx={{ fontVariantNumeric: 'tabular-nums' }}>Configure loop LTV to {(loopLTV * 100).toFixed(2)}%</Text>
                </HStack>
                <HStack>
                  <Text color={SEMANTIC_COLORS.success} fontSize={TYPOGRAPHY.body}>✓</Text>
                  <Text color={SEMANTIC_COLORS.textSecondary}>Execute loop position</Text>
                </HStack>
              </>
            ) : (
              <HStack>
                <Text color={SEMANTIC_COLORS.success} fontSize={TYPOGRAPHY.body}>✓</Text>
                <Text color={SEMANTIC_COLORS.textSecondary} sx={{ fontVariantNumeric: 'tabular-nums' }}>Borrow {borrowAmountFormatted} CDT</Text>
              </HStack>
            )}
          </VStack>
        </Box>

        {/* Market Contract */}
        {/* <Box>
          <Text fontWeight="semibold" mb={2} color={SEMANTIC_COLORS.textPrimary} fontSize="sm">
            Market Contract
          </Text>
          <Text color={SEMANTIC_COLORS.textSecondary} fontSize="xs" fontFamily="mono">
            {marketContract}
          </Text>
        </Box> */}
      </VStack>
    </Box>
  );
};

export default TransformExposureSummary; 