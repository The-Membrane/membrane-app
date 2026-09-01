import React from 'react';
import { Box, Stack, Text, Badge, HStack, Spinner, Alert, AlertIcon } from '@chakra-ui/react';
import { UpdateOverallMarket, UpdateCollateralParams } from './hooks/useManagerState';
import { SEMANTIC_COLORS } from '@/config/semanticColors';
import { TYPOGRAPHY } from '@/helpers/typography';
import { SPACING } from '@/config/spacing';
import { TRANSITIONS, HOVER_EFFECTS, ACTIVE_EFFECTS, FOCUS_STYLES } from '@/config/transitions';

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
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Manager Fee: {data.manager_fee}</Text>
      </Box>
    )}
    {data.debt_supply_cap !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Debt Supply Cap: {data.debt_supply_cap}</Text>
      </Box>
    )}
    {data.whitelisted_debt_suppliers && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Whitelisted Debt Suppliers:</Text>
        <Stack pl={2} spacing={0} fontSize="sm">
          {data.whitelisted_debt_suppliers.map((addr, i) => (
            <Text key={addr}>{addr}</Text>
          ))}
        </Stack>
      </Box>
    )}
    {data.pause_actions !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Pause Actions: {data.pause_actions ? 'Yes' : 'No'}</Text>
      </Box>
    )}
  </Stack>
);

const renderCollateralUpdate = (data: UpdateCollateralParams) => (
  <Stack spacing={2}>
    <Text fontWeight="bold">Collateral Config Update</Text>
    <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
      <Text>Collateral Denom: {data.collateral_denom}</Text>
    </Box>
    {data.max_borrow_LTV !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Max Borrow LTV: {data.max_borrow_LTV}</Text>
      </Box>
    )}
    {data.borrow_fee !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Borrow Fee: {data.borrow_fee}</Text>
      </Box>
    )}
    {data.whitelisted_collateral_suppliers && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Whitelisted Collateral Suppliers:</Text>
        <Stack pl={2} spacing={0} fontSize="sm">
          {data.whitelisted_collateral_suppliers.map((addr, i) => (
            <Text key={addr}>{addr}</Text>
          ))}
        </Stack>
      </Box>
    )}
    {data.per_user_debt_cap !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Per User Debt Cap: {data.per_user_debt_cap}</Text>
      </Box>
    )}
    {data.debt_minimum !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Debt Minimum: {data.debt_minimum}</Text>
      </Box>
    )}
    {data.max_slippage !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Max Slippage: {data.max_slippage}</Text>
      </Box>
    )}
    {data.liquidation_LTV !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Liquidation LTV: {typeof data.liquidation_LTV === 'object' ? JSON.stringify(data.liquidation_LTV) : data.liquidation_LTV}</Text>
      </Box>
    )}
    {data.rate_params !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Rate Params: {typeof data.rate_params === 'object' ? JSON.stringify(data.rate_params) : data.rate_params}</Text>
      </Box>
    )}
    {data.borrow_cap !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Borrow Cap: {typeof data.borrow_cap === 'object' ? JSON.stringify(data.borrow_cap) : data.borrow_cap}</Text>
      </Box>
    )}
    {data.pool_for_oracle_and_liquidations !== undefined && (
      <Box bg={SEMANTIC_COLORS.bgTertiary} p={2} borderRadius={0}>
        <Text>Pool for Oracle and Liquidations: {typeof data.pool_for_oracle_and_liquidations === 'object' ? JSON.stringify(data.pool_for_oracle_and_liquidations) : data.pool_for_oracle_and_liquidations}</Text>
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
            <Alert status="success" borderRadius={0} p={2} fontSize="sm">
              <AlertIcon />Update successful!
            </Alert>
          )}
          {action.isError && (
            <Alert status="error" borderRadius={0} p={2} fontSize="sm">
              <AlertIcon />Update failed: {action.error?.message || 'Unknown error'}
            </Alert>
          )}
        </Box>
      )}
    </Stack>
  );
};

export default UpdateSummary; 