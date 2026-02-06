import { num } from '@/helpers/num'
import { shiftDigits } from '@/helpers/math'
import { Box, Button, HStack, Image, Progress, Stack, Text, Table, Thead, Tbody, Tr, Th, Td, Tooltip, Collapse, Icon } from '@chakra-ui/react'
import { useBasket, useBasketAssets, useRates } from '@/hooks/useCDP'
import { useOraclePrice } from '@/hooks/useOracle'
import useAppState from '@/persisted-state/useAppState'
import { useMemo, useState } from 'react'
import { CollateralRowData, getSymbolFromDenom, getLogoFromSymbol } from './types'
import { getMockCollateralData, USE_MOCK_COLLATERAL_DATA } from './mockCollateralData'
import { ChevronDownIcon, ChevronUpIcon } from '@chakra-ui/icons'

interface AvailableCollateralProps {
  onDeposit?: (denom: string) => void
}

export const AvailableCollateral = ({ onDeposit }: AvailableCollateralProps) => {
  const { appState } = useAppState()
  const { data: prices } = useOraclePrice()
  const { data: basket } = useBasket(appState.rpcUrl)
  const { data: rates } = useRates(appState.rpcUrl)
  const { data: basketAssets } = useBasketAssets()

  // Track expanded rows
  const [expandedRows, setExpandedRows] = useState<Set<string>>(new Set())

  // Mock data for testing supply caps
  const mockData = USE_MOCK_COLLATERAL_DATA ? getMockCollateralData() : null
  const basketData = mockData?.basket || basket
  const pricesData = mockData?.prices || prices
  const basketAssetsData = mockData?.basketAssets || basketAssets

  const toggleRow = (denom: string) => {
    setExpandedRows(prev => {
      const next = new Set(prev)
      if (next.has(denom)) {
        next.delete(denom)
      } else {
        next.add(denom)
      }
      return next
    })
  }

  // Get available collateral from basket
  const collateralRows = useMemo<CollateralRowData[]>(() => {
    if (!basketData || !basketAssetsData || !pricesData) return []

    return basketAssetsData
      .filter(ba => {
        // Filter out assets with zero supply cap
        const supplyCapRatio = num(ba.supplyCapRatio || 0)
        return supplyCapRatio.isGreaterThan(0)
      })
      .map((basketAsset, index) => {
        const denom = basketAsset.asset?.base || ''
        const symbol = basketAsset.asset?.symbol || getSymbolFromDenom(denom, basketData)
        const logo = basketAsset.asset?.logo || getLogoFromSymbol(symbol)
        const priceRaw = pricesData?.find(p => p.denom === denom)?.price || 0
        const price = num(priceRaw).toNumber()

        // Get APY from rates store's lastest_collateral_rates
        const rate = rates?.lastest_collateral_rates?.[index]?.rate
        const apy = rate ? num(rate).times(100).toNumber() : 0

        // Get supply cap info
        const supplyCap = basketData.collateral_supply_caps?.[index]
        const currentSupply = supplyCap
          ? shiftDigits(supplyCap.current_supply, -(basketAsset.asset?.decimal || 6)).toNumber()
          : 0
        const supplyCapRatio = num(supplyCap?.supply_cap_ratio || 0).toNumber()

        // Calculate if supply cap is reached
        // Supply cap check: current_supply / (current_supply + debt_total) >= supply_cap_ratio
        const currentSupplyAmount = supplyCap?.current_supply
          ? shiftDigits(supplyCap.current_supply, -(basketAsset.asset?.decimal || 6)).toNumber()
          : 0
        const debtTotalAmount = supplyCap?.debt_total
          ? shiftDigits(supplyCap.debt_total, -6).toNumber()
          : 0

        const totalValue = currentSupplyAmount + debtTotalAmount
        const currentRatio = totalValue > 0 ? currentSupplyAmount / totalValue : 0
        const isSupplyCapReached = supplyCapRatio > 0 && currentRatio >= supplyCapRatio

        return {
          symbol,
          logo,
          subtext: basketAsset.asset?.description,
          denom,
          apy,
          depositAmount: currentSupply,
          depositUsdValue: num(currentSupply).times(price).toNumber(),
          price,
          maxLTV: basketAsset.maxLTV,
          maxBorrowLTV: basketAsset.maxBorrowLTV,
          supplyCap: supplyCap,
          isDeposited: false,
          isSupplyCapReached,
          currentRatio,
        }
      })
  }, [basketData, basketAssetsData, pricesData, rates])

  if (collateralRows.length === 0) {
    return (
      <Box
        bg="rgba(10, 10, 10, 0.8)"
        borderRadius="lg"
        p={4}
        border="1px solid"
        borderColor="whiteAlpha.200"
      >
        <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
          Available Collateral
        </Text>
        <Text color="whiteAlpha.600" textAlign="center" py={8}>
          Loading available collateral...
        </Text>
      </Box>
    )
  }

  return (
    <Box
      bg="rgba(10, 10, 10, 0.8)"
      borderRadius="lg"
      p={4}
      border="1px solid"
      borderColor="whiteAlpha.200"
    >
      <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
        Available Collateral
      </Text>

      <Table variant="unstyled" size="sm">
        <Thead>
          <Tr>
            <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2}>
              Asset
            </Th>
            <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={2}>
              Deposits / Cap
            </Th>
            <Th px={2} width="100px"></Th>
          </Tr>
        </Thead>
        <Tbody>
          {collateralRows.map((row) => {
            const supplyCapRatio = num(row.supplyCap?.supply_cap_ratio || 0).toNumber()
            const isExpanded = expandedRows.has(row.denom)

            // Calculate actual supply usage percentage based on current ratio vs cap
            const supplyUsagePercent = supplyCapRatio > 0 && row.currentRatio !== undefined
              ? Math.min((row.currentRatio / supplyCapRatio) * 100, 100)
              : 0

            const isSupplyCapReached = row.isSupplyCapReached || false

            return (
              <>
                <Tr
                  key={row.denom}
                  _hover={{ bg: 'whiteAlpha.50' }}
                  opacity={isSupplyCapReached ? 0.6 : 1}
                  borderBottom="1px solid"
                  borderColor="whiteAlpha.100"
                  cursor="pointer"
                  onClick={() => toggleRow(row.denom)}
                >
                  <Td px={2} py={3}>
                    <HStack spacing={2}>
                      <Icon
                        as={isExpanded ? ChevronUpIcon : ChevronDownIcon}
                        color="whiteAlpha.600"
                        w={4}
                        h={4}
                      />
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
                        <HStack spacing={1}>
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
                    <Stack spacing={1}>
                      <HStack justifyContent="space-between">
                        <Text
                          color={isSupplyCapReached ? 'red.400' : 'whiteAlpha.700'}
                          fontSize="xs"
                          fontWeight={isSupplyCapReached ? 'bold' : 'normal'}
                        >
                          {supplyCapRatio > 0
                            ? `${num(row.currentRatio || 0).times(100).toFixed(1)}% / ${num(supplyCapRatio).times(100).toFixed(0)}%`
                            : `$${num(row.depositUsdValue).toFixed(0)}`
                          }
                        </Text>
                      </HStack>
                      <Progress
                        value={supplyUsagePercent}
                        size="xs"
                        colorScheme={
                          isSupplyCapReached ? 'red' :
                          supplyUsagePercent > 80 ? 'orange' :
                          supplyUsagePercent > 60 ? 'yellow' :
                          'cyan'
                        }
                        bg="whiteAlpha.200"
                        borderRadius="full"
                      />
                    </Stack>
                  </Td>
                  <Td px={2} py={3} onClick={(e) => e.stopPropagation()}>
                    <Tooltip
                      label="Supply cap reached - deposits to positions with debt are disabled"
                      isDisabled={!isSupplyCapReached}
                      placement="top"
                    >
                      <Button
                        size="xs"
                        colorScheme={isSupplyCapReached ? 'red' : 'cyan'}
                        variant={isSupplyCapReached ? 'outline' : 'solid'}
                        onClick={() => onDeposit?.(row.denom)}
                        isDisabled={isSupplyCapReached}
                        cursor={isSupplyCapReached ? 'not-allowed' : 'pointer'}
                      >
                        {isSupplyCapReached ? 'Cap Reached' : 'Deposit'}
                      </Button>
                    </Tooltip>
                  </Td>
                </Tr>
                {/* Expanded row content */}
                <Tr key={`${row.denom}-expanded`}>
                  <Td colSpan={3} p={0} borderBottom="1px solid" borderColor="whiteAlpha.100">
                    <Collapse in={isExpanded} animateOpacity>
                      <Box
                        p={4}
                        bg="rgba(0, 0, 0, 0.3)"
                        borderLeft="2px solid"
                        borderColor="cyan.500"
                      >
                        <Stack spacing={4}>
                          {/* Stats Grid */}
                          <HStack spacing={8} justify="space-around">
                            <Stack spacing={1} align="center">
                              <Text color="whiteAlpha.600" fontSize="xs">
                                Max LTV
                              </Text>
                              <Text color="white" fontSize="lg" fontWeight="bold">
                                {num(row.maxLTV || 0).times(100).toFixed(2)}%
                              </Text>
                            </Stack>
                            <Stack spacing={1} align="center">
                              <Text color="whiteAlpha.600" fontSize="xs">
                                Liquidation LTV
                              </Text>
                              <Text color="white" fontSize="lg" fontWeight="bold">
                                {num(row.maxBorrowLTV || 0).times(100).toFixed(2)}%
                              </Text>
                            </Stack>
                            <Stack spacing={1} align="center">
                              <Text color="whiteAlpha.600" fontSize="xs">
                                Oracle Price
                              </Text>
                              <Text color="white" fontSize="lg" fontWeight="bold">
                                ${row.price.toFixed(2)}
                              </Text>
                            </Stack>
                          </HStack>

                          {/* Chart placeholder */}
                          <Box
                            h="200px"
                            bg="rgba(0, 0, 0, 0.2)"
                            borderRadius="md"
                            display="flex"
                            alignItems="center"
                            justifyContent="center"
                            border="1px solid"
                            borderColor="whiteAlpha.200"
                          >
                            <Text color="whiteAlpha.500" fontSize="sm">
                              Historical LTV Chart (Coming Soon)
                            </Text>
                          </Box>
                        </Stack>
                      </Box>
                    </Collapse>
                  </Td>
                </Tr>
              </>
            )
          })}
        </Tbody>
      </Table>
    </Box>
  )
}

export default AvailableCollateral
