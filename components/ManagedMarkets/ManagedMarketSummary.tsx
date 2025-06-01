import React from 'react';
import { Box, HStack, Stack, Text, Badge, Image } from '@chakra-ui/react';
import { num } from '@/helpers/num';
import { ManagedActionState } from './hooks/useManagedMarket';

// Types for props
// managedActionState: { collateralAmount, multiplier, takeProfit, stopLoss }
// borrowAndBoost: useQuery result (msgs)
// collateralAsset: asset object (symbol, logo, etc)

interface ManagedMarketSummaryProps {
  managedActionState: ManagedActionState;
  borrowAndBoost: any; // TODO: type this more specifically if possible
  collateralAsset: any; // TODO: type this more specifically if possible
  debtAmount: string | undefined;
}

const ManagedMarketSummary: React.FC<ManagedMarketSummaryProps> = ({ managedActionState, borrowAndBoost, collateralAsset, debtAmount }) => {
  const { collateralAmount, multiplier, takeProfit, stopLoss } = managedActionState;
  const msgs = borrowAndBoost?.data?.msgs || [];


  return (
    <Stack spacing={4} w="full" p={2}>
      <Text fontWeight="bold" fontSize="lg">Summary</Text>
      <HStack justifyContent="space-between">
        <HStack>
          <Image src={collateralAsset?.logo} w="24px" h="24px" />
          <Text>{collateralAsset?.symbol}</Text>
        </HStack>
        <Badge colorScheme="green">Deposit</Badge>
        <Text>${num(collateralAmount).toFixed(2)}</Text>
      </HStack>
      <HStack justifyContent="space-between">
        <Text>Multiplier </Text>
        <Text>{multiplier.toFixed(2)}x</Text>
      </HStack>
      {takeProfit && (
        <HStack justifyContent="space-between">
          <Text>Take Profit @ </Text>
          <Text>${takeProfit}</Text>
        </HStack>
      )}
      {stopLoss && (
        <HStack justifyContent="space-between">
          <Text>Stop Loss @ </Text>
          <Text>${stopLoss}</Text>
        </HStack>
      )}
      <Box>
        <Text fontWeight="semibold" mb={1}>Pending Position:</Text>
        <Stack spacing={2} fontSize="xs">
          <Box key="collateralAmount" bg="gray.800" p={2} borderRadius="md" overflowX="auto">
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>Collateral Amount: {collateralAmount}</pre>
          </Box>
          <Box key="multiplier" bg="gray.800" p={2} borderRadius="md" overflowX="auto">
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>Multiplier: {multiplier}</pre>
          </Box>
          {debtAmount && (
            <Box key="debtAmount" bg="gray.800" p={2} borderRadius="md" overflowX="auto">
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>Debt Amount: {debtAmount}</pre>
            </Box>
          )}
          {takeProfit && (
            <Box key="takeProfit" bg="gray.800" p={2} borderRadius="md" overflowX="auto">
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>Take Profit: {takeProfit}</pre>
            </Box>
          )}
          {stopLoss && (
            <Box key="stopLoss" bg="gray.800" p={2} borderRadius="md" overflowX="auto">
              <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>Stop Loss: {stopLoss}</pre>
            </Box>
          )}
        </Stack>
      </Box>
    </Stack>
  );
};

export default ManagedMarketSummary; 