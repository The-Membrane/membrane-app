import { num } from '@/helpers/num'
import { shiftDigits } from '@/helpers/math'
import { Box, Button, HStack, Image, Stack, Text, Tr, Td, Tooltip, Collapse, Icon, VStack } from '@chakra-ui/react'
import { Fragment } from 'react'
import { CollateralRowData } from './types'
import { ChevronDownIcon, ChevronUpIcon } from '@chakra-ui/icons'
import { ProgressBar } from '@/components/ui/ProgressBar'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

// Format large numbers with K/M suffix
const formatLargeNumber = (value: number): string => {
  if (value >= 1000000) {
    const millions = value / 1000000
    return `$${millions.toFixed(millions >= 10 ? 1 : 2)}M`
  } else if (value >= 1000) {
    const thousands = value / 1000
    return `$${thousands.toFixed(thousands >= 10 ? 0 : 1)}K`
  } else {
    return `$${value.toFixed(0)}`
  }
}

interface CollateralRowProps {
  row: CollateralRowData
  isExpanded: boolean
  onToggleExpand: (denom: string) => void
  onDeposit: (denom: string) => void
}

export const CollateralRow = ({ row, isExpanded, onToggleExpand, onDeposit }: CollateralRowProps) => {
  const supplyCapRatio = num(row.supplyCap?.supply_cap_ratio || 0).toNumber()

  // Calculate actual supply usage percentage based on current ratio vs cap
  const supplyUsagePercent = supplyCapRatio > 0 && row.currentRatio !== undefined
    ? Math.min((row.currentRatio / supplyCapRatio) * 100, 100)
    : 0

  const isSupplyCapReached = row.isSupplyCapReached || false

  // Calculate actual dollar values
  // Current deposits are already in row.depositAmount (properly shifted)
  const currentUsdValue = row.depositUsdValue

  // Calculate max allowed supply using the formula:
  // At cap: current_supply / (current_supply + debt_total) = supply_cap_ratio
  // So max_supply = (supply_cap_ratio * debt_total) / (1 - supply_cap_ratio)
  const debtTotalAmount = row.supplyCap?.debt_total
    ? shiftDigits(row.supplyCap.debt_total, -6).toNumber()
    : 0

  const maxSupplyAllowed = supplyCapRatio > 0 && supplyCapRatio < 1
    ? (supplyCapRatio * debtTotalAmount) / (1 - supplyCapRatio)
    : row.depositAmount

  const maxCapUsdValue = num(maxSupplyAllowed).times(row.price).toNumber()

  return (
    <Fragment key={row.denom}>
      <Tr
        _hover={{ bg: 'whiteAlpha.50' }}
        opacity={isSupplyCapReached ? 0.7 : 1}
      >
        <Td px={2} py={3}>
          <HStack spacing={2}>
            <Image
              src={row.logo}
              alt={row.symbol}
              w="24px"
              h="24px"
              borderRadius="full"
              fallbackSrc="/images/default-token.svg"
              opacity={isSupplyCapReached ? 0.5 : 1}
            />
            <Stack spacing={0}>
              <HStack spacing={2}>
                <Text
                  color="white"
                  fontWeight="medium"
                  fontSize="sm"
                >
                  {row.symbol}
                </Text>
                {isSupplyCapReached && (
                  <Text color="red.400" fontSize="xs" fontWeight="bold">
                    (CAP REACHED)
                  </Text>
                )}
              </HStack>
              <Text color="whiteAlpha.500" fontSize="xs">
                Max LTV: {num(row.maxBorrowLTV).times(100).toFixed(0)}%
              </Text>
            </Stack>
          </HStack>
        </Td>
        <Td px={2} py={3}>
          {supplyCapRatio > 0 ? (
            <ProgressBar
              value={currentUsdValue}
              maxValue={maxCapUsdValue}
              formatValue={formatLargeNumber}
              size="sm"
            />
          ) : (
            <Text
              color="white"
              fontSize="sm"
              fontWeight="medium"
            >
              {formatLargeNumber(row.depositUsdValue)}
            </Text>
          )}
        </Td>
        <Td px={2} py={3}>
          <HStack spacing={2} justify="flex-end">
            <Tooltip
              label="Supply cap reached - deposits to positions with debt are disabled"
              isDisabled={!isSupplyCapReached}
              placement="top"
              hasArrow
            >
              <Button
                size="xs"
                colorScheme="primary"
                variant="outline"
                onClick={() => onDeposit(row.denom)}
                isDisabled={isSupplyCapReached}
                cursor={isSupplyCapReached ? 'not-allowed' : 'pointer'}
                borderColor={isSupplyCapReached ? 'rgba(207, 64, 52, 0.3)' : '#9bdc4f'}
                color={isSupplyCapReached ? '#56524a' : '#9bdc4f'}
                _hover={!isSupplyCapReached ? {
                  bg: '#9bdc4f',
                  color: '#09090a',
                  borderColor: '#9bdc4f'
                } : undefined}
              >
                {isSupplyCapReached ? 'Full' : 'Deposit'}
              </Button>
            </Tooltip>
            <Icon
              as={isExpanded ? ChevronUpIcon : ChevronDownIcon}
              color="whiteAlpha.600"
              w={5}
              h={5}
              cursor="pointer"
              onClick={() => onToggleExpand(row.denom)}
              _hover={{ color: 'whiteAlpha.800' }}
            />
          </HStack>
        </Td>
      </Tr>
      {/* Expanded row content */}
      <Tr key={`${row.denom}-expanded`}>
        <Td colSpan={3} p={0}>
          <Collapse in={isExpanded} animateOpacity>
            <Box
              p={3}
              bg="rgba(0, 0, 0, 0.3)"
              borderLeft="2px solid"
              borderColor="#46d39a"
            >
              <VStack spacing={3} align="stretch">
                {/* Stats Row — chain values only; the mock pending-LTV/countdown branch was
                    removed so nothing fabricated renders in the live mint tree */}
                <HStack spacing={6} justify="space-around" align="flex-start">
                  <Stack spacing={0} align="center">
                    <Text color={SEMANTIC_COLORS.textTertiary} fontSize={TYPOGRAPHY.xs}>
                      Liquidation LTV
                    </Text>
                    <Text color="white" fontSize={TYPOGRAPHY.small} fontWeight={TYPOGRAPHY.bold}>
                      {num(row.maxLTV || 0).times(100).toFixed(1)}%
                    </Text>
                  </Stack>
                  <Stack spacing={0} align="center">
                    <Text color={SEMANTIC_COLORS.textTertiary} fontSize={TYPOGRAPHY.xs}>
                      Target LTV
                    </Text>
                    <Text color={SEMANTIC_COLORS.success} fontSize={TYPOGRAPHY.small} fontWeight={TYPOGRAPHY.bold}>
                      {`${num(row.maxBorrowLTV || 0).times(100).toFixed(1)}%`}
                    </Text>
                  </Stack>
                  <Stack spacing={0} align="center">
                    <Text color={SEMANTIC_COLORS.textTertiary} fontSize={TYPOGRAPHY.xs}>
                      Oracle Price
                    </Text>
                    <Text color="white" fontSize={TYPOGRAPHY.small} fontWeight={TYPOGRAPHY.bold}>
                      ${row.price.toFixed(2)}
                    </Text>
                  </Stack>
                </HStack>
              </VStack>
            </Box>
          </Collapse>
        </Td>
      </Tr>
    </Fragment>
  )
}
