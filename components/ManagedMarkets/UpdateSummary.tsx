import React from 'react';
import { Box, Stack, Text, Badge, HStack, Spinner, Alert, AlertIcon } from '@chakra-ui/react';
import { UpdateOverallMarket, UpdateCollateralParams } from './hooks/useManagerState';

interface UpdateSummaryProps {
  type: 'market' | 'collateral';
  updateData: UpdateOverallMarket | UpdateCollateralParams;
  action?: {
    isLoading?: boolean;
    isSuccess?: boolean;
    isError?: boolean;
    error?: any;
  };
}

const renderMarketUpdate = (data: UpdateOverallMarket) => (
  <Stack spacing={2}>
    <Text fontWeight="bold">Market Update</Text>
    {data.manager_fee !== undefined && (
      <Box bg="gray.800" p={2} borderRadius="md">
        <Text>Manager Fee: {data.manager_fee}</Text>
      </Box>
    )}
    {data.debt_supply_cap !== undefined && (
      <Box bg="gray.800" p={2} borderRadius="md">
        <Text>Debt Supply Cap: {data.debt_supply_cap}</Text>
      </Box>
    )}
    {data.per_user_debt_cap !== undefined && (
      <Box bg="gray.800" p={2} borderRadius="md">
        <Text>Per User Debt Cap: {data.per_user_debt_cap}</Text>
      </Box>
    )}
    {data.whitelisted_debt_suppliers && (
      <Box bg="gray.800" p={2} borderRadius="md">
        <Text>Whitelisted Debt Suppliers:</Text>
        <Stack pl={2} spacing={0} fontSize="sm">
          {data.whitelisted_debt_suppliers.map((addr, i) => (
            <Text key={i}>{addr}</Text>
          ))}
        </Stack>
      </Box>
    )}
    {data.pause_actions !== undefined && (
      <Box bg="gray.800" p={2} borderRadius="md">
        <Text>Pause Actions: {data.pause_actions ? 'Yes' : 'No'}</Text>
      </Box>
    )}
  </Stack>
);

const renderCollateralUpdate = (data: UpdateCollateralParams) => (
  <Stack spacing={2}>
    <Text fontWeight="bold">Collateral Config Update</Text>
    <Box bg="gray.800" p={2} borderRadius="md">
      <Text>Collateral Denom: {data.collateral_denom}</Text>
    </Box>
    {data.max_borrow_LTV !== undefined && (
      <Box bg="gray.800" p={2} borderRadius="md">
        <Text>Max Borrow LTV: {data.max_borrow_LTV}</Text>
      </Box>
    )}
    {data.borrow_fee !== undefined && (
      <Box bg="gray.800" p={2} borderRadius="md">
        <Text>Borrow Fee: {data.borrow_fee}</Text>
      </Box>
    )}
    {data.whitelisted_collateral_suppliers && (
      <Box bg="gray.800" p={2} borderRadius="md">
        <Text>Whitelisted Collateral Suppliers:</Text>
        <Stack pl={2} spacing={0} fontSize="sm">
          {data.whitelisted_collateral_suppliers.map((addr, i) => (
            <Text key={i}>{addr}</Text>
          ))}
        </Stack>
      </Box>
    )}
    {/* Add more fields as needed */}
  </Stack>
);

const UpdateSummary: React.FC<UpdateSummaryProps> = ({ type, updateData, action }) => {
  return (
    <Stack spacing={4} w="full" p={2}>
      <Text fontWeight="bold" fontSize="lg">Update Summary</Text>
      {type === 'market'
        ? renderMarketUpdate(updateData as UpdateOverallMarket)
        : renderCollateralUpdate(updateData as UpdateCollateralParams)}
      {action && (
        <Box>
          {action.isLoading && (
            <HStack><Spinner size="sm" /><Text>Broadcasting update...</Text></HStack>
          )}
          {action.isSuccess && (
            <Alert status="success" borderRadius="md" p={2} fontSize="sm">
              <AlertIcon />Update successful!
            </Alert>
          )}
          {action.isError && (
            <Alert status="error" borderRadius="md" p={2} fontSize="sm">
              <AlertIcon />Update failed: {action.error?.message || 'Unknown error'}
            </Alert>
          )}
        </Box>
      )}
    </Stack>
  );
};

export default UpdateSummary; 