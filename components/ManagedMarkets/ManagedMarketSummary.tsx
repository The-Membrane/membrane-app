import React from 'react';
import { Box, HStack, Stack, Text, Badge, Image, VStack } from '@chakra-ui/react';
import {shiftDigits } from '@/helpers/math';
import { ManagedActionState } from './hooks/useManagedMarketState';
import { num } from '@/helpers/num';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';

// Types for props
// managedActionState: { collateralAmount, multiplier, takeProfit, stopLoss }
// borrowAndBoost: useQuery result (msgs)
// collateralAsset: asset object (symbol, logo, etc)

interface ManagedMarketSummaryProps {
  managedActionState: ManagedActionState;
  borrowAndBoost: any; // TODO: type this more specifically if possible
  collateralAsset: any; // TODO: type this more specifically if possible
  debtAmount: string | undefined;
  collateralPrice: string | undefined;
  debtPrice: string | undefined;
}

const ManagedMarketSummary: React.FC<ManagedMarketSummaryProps> = ({ managedActionState, borrowAndBoost, collateralAsset, debtAmount, collateralPrice, debtPrice }) => {
  const { collateralAmount, multiplier, takeProfit, stopLoss } = managedActionState;
//   const msgs = borrowAndBoost?.data?.msgs || []
  const collateralValue = num(collateralPrice).times(collateralAmount);

  // Calculate post-loop debt amount
  const postLoopDebtAmount = num(collateralValue).times(multiplier - 1).div(debtPrice || 1);
  console.log('postLoopDebtAmount', collateralValue, collateralPrice, multiplier, postLoopDebtAmount.toString(), debtPrice);

  // Placeholder values for fields not in props
  const liquidationPrice = undefined; // TODO: pass as prop if needed
  const ltv = undefined; // TODO: pass as prop if needed
  const health = undefined; // TODO: pass as prop if needed

  return (
    <Box
      w="100%"
      bg={SEMANTIC_COLORS.bgTertiary}
      borderRadius={0}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p={SPACING.lg}
      mt={SPACING.none}
      mb={SPACING.sm}
    >
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        textTransform="uppercase"
        letterSpacing="0.28em"
        color={SEMANTIC_COLORS.textSecondary}
        mb={SPACING.sm}
      >
        Pending Position:
      </Text>
      <VStack align="stretch" spacing={SPACING.sm} fontSize={TYPOGRAPHY.xs}>
        <HStack justify="space-between">
          <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary}>Collateral Amount</Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.medium} sx={{ fontVariantNumeric: 'tabular-nums' }}>{collateralAmount} {collateralAsset?.symbol}</Text>
        </HStack>
        <HStack justify="space-between">
          <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary}>Multiplier</Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.medium} sx={{ fontVariantNumeric: 'tabular-nums' }}>{multiplier.toFixed(2)}x</Text>
        </HStack>
        <HStack justify="space-between">
          <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary}>Debt</Text>
          <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary} fontWeight={TYPOGRAPHY.medium} sx={{ fontVariantNumeric: 'tabular-nums' }}>{postLoopDebtAmount && Number(postLoopDebtAmount) > 0 ? `$${num(postLoopDebtAmount).toFixed(2)}` : '-'}</Text>
        </HStack>
      </VStack>
    </Box>
  );
};

export default ManagedMarketSummary; 