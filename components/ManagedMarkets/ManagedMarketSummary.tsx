import React from 'react';
import { Box, HStack, Stack, Text, Badge, Image, VStack } from '@chakra-ui/react';
import {shiftDigits } from '@/helpers/math';
import { ManagedActionState } from './hooks/useManagedMarket';
import { num } from '@/helpers/num';

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
    <Box w="100%" bg="#181C23" borderRadius="lg" p={6} mt={0} mb={2}>
      <Text fontWeight="semibold" mb={2}>Pending Position:</Text>
      <VStack align="stretch" spacing={2} fontSize="xs">
        <HStack justify="space-between">
          <Text color="whiteAlpha.700">Collateral Amount</Text>
          <Text color="white" fontWeight="bold">{collateralAmount} {collateralAsset?.symbol}</Text>
        </HStack>
        <HStack justify="space-between">
          <Text color="whiteAlpha.700">Multiplier</Text>
          <Text color="white" fontWeight="bold">{multiplier.toFixed(2)}x</Text>
        </HStack>
        <HStack justify="space-between">
          <Text color="whiteAlpha.700">Debt</Text>
          <Text color="white" fontWeight="bold">{postLoopDebtAmount && Number(postLoopDebtAmount) > 0 ? `$${num(postLoopDebtAmount).toFixed(2)}` : '-'}</Text>
        </HStack>
      </VStack>
    </Box>
  );
};

export default ManagedMarketSummary; 