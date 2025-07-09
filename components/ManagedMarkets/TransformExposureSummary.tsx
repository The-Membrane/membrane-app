import React from 'react';
import { Box, VStack, HStack, Text, Badge, Divider } from '@chakra-ui/react';
import { Asset } from '@/helpers/chain';
import { num } from '@/helpers/num';
import { shiftDigits } from '@/helpers/math';
import BigNumber from 'bignumber.js';
import { m } from 'framer-motion';
import { Formatter } from '@/helpers/formatter';

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
    <Box w="100%" bg="#181C23" borderRadius="lg" p={6} mt={0} mb={2}>
      <VStack align="stretch" spacing={4}>
        {/* Header */}
        <Box>
          <HStack justify="space-between" mb={2}>
            <Text fontWeight="bold" fontSize="lg">
              Transform Exposure Summary
            </Text>
            <Badge 
              colorScheme={mode === 'multiply' ? 'green' : 'orange'} 
              variant="solid"
              fontSize="sm"
            >
              {mode === 'multiply' ? 'MULTIPLY' : 'DE-RISK'}
            </Badge>
          </HStack>
          <Text color="whiteAlpha.700" fontSize="sm">
            {mode === 'multiply' 
              ? 'Increase your exposure through looping strategy'
              : 'Reduce your exposure by borrowing against collateral'
            }
          </Text>
        </Box>

        <Divider borderColor="whiteAlpha.300" />

        {/* Collateral Details */}
        <Box>
          <Text fontWeight="semibold" mb={3} color="whiteAlpha.900">
            Collateral Details
          </Text>
          <VStack align="stretch" spacing={2} fontSize="sm">
            <HStack justify="space-between">
              <Text color="whiteAlpha.700">Asset</Text>
              <Text color="white" fontWeight="bold">{asset.symbol}</Text>
            </HStack>
            <HStack justify="space-between">
              <Text color="whiteAlpha.700">Collateral Amount</Text>
              <Text color="white" fontWeight="bold">
                {collateralAmountFormatted} {asset.symbol}
              </Text>
            </HStack>
            <HStack justify="space-between">
              <Text color="whiteAlpha.700">Collateral Value</Text>
              <Text color="white" fontWeight="bold">${collateralValue.toFixed(2)}</Text>
            </HStack>
          </VStack>
        </Box>

        <Divider borderColor="whiteAlpha.300" />

        {/* Strategy Details */}
        <Box>
          <Text fontWeight="semibold" mb={3} color="whiteAlpha.900">
            Strategy Details
          </Text>
          <VStack align="stretch" spacing={2} fontSize="sm">
           
           {mode === 'multiply' && (
            <HStack justify="space-between">
              <Text color="whiteAlpha.700">Multiplier</Text>
              <Text color="white" fontWeight="bold">{multiplier.toFixed(2)}x</Text>
            </HStack>
           )}
            {mode === 'de-risk' && (
              <HStack justify="space-between">
                <Text color="whiteAlpha.700">Borrow Amount</Text>
                <Text color="white" fontWeight="bold">
                  {borrowAmountFormatted} CDT
                </Text>
              </HStack>
            )}
          </VStack>
        </Box>

        <Divider borderColor="whiteAlpha.300" />


        <Divider borderColor="whiteAlpha.300" />

        {/* Actions to be Performed */}
        <Box>
          <Text fontWeight="semibold" mb={3} color="whiteAlpha.900">
            Actions to be Performed
          </Text>
          <VStack align="stretch" spacing={2} fontSize="sm">
            <HStack>
              <Text color="green.400" fontSize="lg">✓</Text>
              <Text color="whiteAlpha.700">Deposit {collateralAmountFormatted} {asset.symbol}</Text>
            </HStack>
            
            {mode === 'multiply' ? (
              <>
                <HStack>
                  <Text color="green.400" fontSize="lg">✓</Text>
                  <Text color="whiteAlpha.700">Configure loop LTV to {(loopLTV * 100).toFixed(2)}%</Text>
                </HStack>
                <HStack>
                  <Text color="green.400" fontSize="lg">✓</Text>
                  <Text color="whiteAlpha.700">Execute loop position</Text>
                </HStack>
              </>
            ) : (
              <HStack>
                <Text color="green.400" fontSize="lg">✓</Text>
                <Text color="whiteAlpha.700">Borrow {borrowAmountFormatted} CDT</Text>
              </HStack>
            )}
          </VStack>
        </Box>

        {/* Market Contract */}
        {/* <Box>
          <Text fontWeight="semibold" mb={2} color="whiteAlpha.900" fontSize="sm">
            Market Contract
          </Text>
          <Text color="whiteAlpha.600" fontSize="xs" fontFamily="mono">
            {marketContract}
          </Text>
        </Box> */}
      </VStack>
    </Box>
  );
};

export default TransformExposureSummary; 