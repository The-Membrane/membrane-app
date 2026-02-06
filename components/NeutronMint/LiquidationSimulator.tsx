import React, { useMemo, useState } from 'react'
import { Box, VStack, HStack, Text, Table, Thead, Tbody, Tr, Th, Td, Image, Collapse } from '@chakra-ui/react'
import { num } from '@/helpers/num'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { useCapitalRecallAmount, CapitalRecallResult } from './hooks/useCapitalRecall'
import { useLiquidationQueueSimulation, LiqQueueSimulationResult } from './hooks/useLiquidationQueueSimulation'
import { useMarketSaleSimulation, MarketSaleSimulationResult } from './hooks/useMarketSaleSimulation'
import { getVenueLabel } from '@/config/venueLabels'

interface LiquidationSimulatorProps {
  collateralValue: number
  liquidationLTV: number
  borrowLTV: number
  positionIndex?: number
  position?: PositionResponse
  userAddress?: string
}

interface LiquidationStage {
  name: string
  fulfilledAmount: number
  cost: number
  dropdownType?: 'capitalRecall' | 'liqQueue' | 'marketSale'
}

// Mock data for development testing
const MOCK_CAPITAL_RECALL: CapitalRecallResult = {
  total: 30,
  perVenue: [
    { address: 'osmo1fqcwupyh6s703rn0lkxfx0ch2lyrw6lz4dedecx0y3ced2jq04tq0mva2l', amount: 18 },
    { address: 'osmo1tmqefg7v9zhtj2hlsrtn3mp8zz83x9lxtedlzesnky4c74l4g9ws29dqxr', amount: 12 },
  ],
}

const getMockLiqQueueResult = (remainingDebt: number): LiqQueueSimulationResult => {
  const osmoShare = remainingDebt * 0.5
  const atomShare = remainingDebt * 0.3
  const stAtomShare = remainingDebt * 0.2

  return {
    totalDebtRepaid: num(osmoShare).times(0.85).plus(num(atomShare).times(0.90)).plus(num(stAtomShare).times(0.80)).toNumber(),
    totalCost: num(osmoShare).times(0.15).plus(num(atomShare).times(0.10)).plus(num(stAtomShare).times(0.20)).toNumber(),
    perAsset: [
      {
        symbol: 'OSMO',
        logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.svg',
        denom: 'uosmo',
        debtRepaid: num(osmoShare).times(0.85).toNumber(),
        cost: num(osmoShare).times(0.15).toNumber(),
      },
      {
        symbol: 'ATOM',
        logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/cosmoshub/images/atom.svg',
        denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
        debtRepaid: num(atomShare).times(0.90).toNumber(),
        cost: num(atomShare).times(0.10).toNumber(),
      },
      {
        symbol: 'stATOM',
        logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/stride/images/statom.svg',
        denom: 'ibc/C140AFD542AE77BD7DCC83F13FDD8C5E5BB8C4929785E6EC2F4C636F98F17901',
        debtRepaid: num(stAtomShare).times(0.80).toNumber(),
        cost: num(stAtomShare).times(0.20).toNumber(),
      },
    ],
  }
}

const getMockMarketSaleResult = (remainingDebt: number) => {
  if (remainingDebt <= 0) return null

  // Simulate selling OSMO and ATOM collateral
  const osmoInputValue = remainingDebt * 0.6
  const atomInputValue = remainingDebt * 0.4

  // 8% slippage on OSMO (direct swap)
  const osmoOutputValue = num(osmoInputValue).times(0.92).toNumber()
  const osmoSlippage = num(osmoInputValue).times(0.08).toNumber()

  // 12% slippage on ATOM (multi-hop: ATOM -> OSMO -> CDT)
  const atomOutputValue = num(atomInputValue).times(0.88).toNumber()
  const atomSlippage = num(atomInputValue).times(0.12).toNumber()

  return {
    totalInputValue: osmoInputValue + atomInputValue,
    totalOutputValue: osmoOutputValue + atomOutputValue,
    totalSlippageCost: osmoSlippage + atomSlippage,
    perAsset: [
      {
        symbol: 'OSMO',
        logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.svg',
        denom: 'uosmo',
        inputValue: osmoInputValue,
        outputValue: osmoOutputValue,
        slippageCost: osmoSlippage,
        routes: [
          {
            dex: 'astroport' as const,
            tokenIn: 'uosmo',
            tokenOut: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt',
            amountIn: osmoInputValue,
            amountOut: osmoOutputValue,
            symbol: 'OSMO',
            logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.svg',
          },
        ],
      },
      {
        symbol: 'ATOM',
        logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/cosmoshub/images/atom.svg',
        denom: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
        inputValue: atomInputValue,
        outputValue: atomOutputValue,
        slippageCost: atomSlippage,
        routes: [
          {
            dex: 'astroport' as const,
            tokenIn: 'ibc/27394FB092D2ECCD56123C74F36E4C1F926001CEADA9CA97EA622B25F41E5EB2',
            tokenOut: 'uosmo',
            amountIn: atomInputValue,
            amountOut: atomInputValue * 0.95,
            symbol: 'ATOM',
            logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/cosmoshub/images/atom.svg',
          },
          {
            dex: 'astroport' as const,
            tokenIn: 'uosmo',
            tokenOut: 'factory/osmo1s794h9rxggytja3a4pmwul53u98k06zy2qtrdvjnfuxruh7s8yjs6cyxgd/ucdt',
            amountIn: atomInputValue * 0.95,
            amountOut: atomOutputValue,
            symbol: 'OSMO',
            logo: 'https://raw.githubusercontent.com/cosmos/chain-registry/master/osmosis/images/osmo.svg',
          },
        ],
      },
    ],
    asteriskNote: '*Astroport simulation only',
  }
}

export const LiquidationSimulator: React.FC<LiquidationSimulatorProps> = ({
  collateralValue,
  liquidationLTV,
  borrowLTV,
  position,
  userAddress,
}) => {
  const [capitalRecallOpen, setCapitalRecallOpen] = useState(false)
  const [liqQueueOpen, setLiqQueueOpen] = useState(false)
  const [marketSaleOpen, setMarketSaleOpen] = useState(false)

  // Get Capital Recall breakdown from deployment venues
  const { data: capitalRecallData } = useCapitalRecallAmount(position, userAddress)

  const USE_MOCK_DATA = process.env.NODE_ENV === 'development'
  const mockCollateralValue = 1000
  const mockLiquidationLTV = 80
  const mockBorrowLTV = 70

  const effectiveCollateralValue = collateralValue > 0 ? collateralValue : (USE_MOCK_DATA ? mockCollateralValue : 0)
  const effectiveLiquidationLTV = liquidationLTV > 0 ? liquidationLTV : (USE_MOCK_DATA ? mockLiquidationLTV : 0)
  const effectiveBorrowLTV = borrowLTV > 0 ? borrowLTV : (USE_MOCK_DATA ? mockBorrowLTV : 0)

  // Capital recall: use real data if available, otherwise mock in dev
  const effectiveCapitalRecall = useMemo<CapitalRecallResult>(() => {
    if (capitalRecallData && capitalRecallData.total > 0) return capitalRecallData
    if (USE_MOCK_DATA) return MOCK_CAPITAL_RECALL
    return { total: 0, perVenue: [] }
  }, [capitalRecallData, USE_MOCK_DATA])

  // Calculate liquidation threshold
  const liquidationThreshold = useMemo(() => {
    if (effectiveCollateralValue <= 0 || effectiveLiquidationLTV <= 0) return 0
    return num(effectiveCollateralValue).times(effectiveLiquidationLTV).dividedBy(100).toNumber()
  }, [effectiveCollateralValue, effectiveLiquidationLTV])

  // Calculate liquidated amount (from liquidationLTV to borrowLTV)
  const liquidatedAmount = useMemo(() => {
    if (effectiveCollateralValue <= 0 || effectiveLiquidationLTV <= 0 || effectiveBorrowLTV <= 0) return 0
    const ltvDifference = num(effectiveLiquidationLTV).minus(effectiveBorrowLTV).toNumber()
    if (ltvDifference <= 0) return 0
    return num(effectiveCollateralValue).times(ltvDifference).dividedBy(100).toNumber()
  }, [effectiveCollateralValue, effectiveLiquidationLTV, effectiveBorrowLTV])

  // Calculate remaining amount after Capital Recall
  const remainingAmount = useMemo(() => {
    return Math.max(0, num(liquidatedAmount).minus(effectiveCapitalRecall.total).toNumber())
  }, [liquidatedAmount, effectiveCapitalRecall.total])

  // Query liquidation queue for each collateral asset
  const { data: liqQueueResult } = useLiquidationQueueSimulation(remainingAmount, position)

  // Calculate remaining amount after Liquidation Queue
  const remainingAfterLiqQueue = useMemo(() => {
    const liqQueueFulfilled = liqQueueResult?.totalDebtRepaid ?? 0
    return Math.max(0, num(remainingAmount).minus(liqQueueFulfilled).toNumber())
  }, [remainingAmount, liqQueueResult])

  // Query market sale simulation for remaining debt
  const { data: marketSaleResult } = useMarketSaleSimulation(remainingAfterLiqQueue, position)

  // Use real data if available, otherwise mock in dev
  const effectiveLiqQueueResult = useMemo<LiqQueueSimulationResult | null>(() => {
    if (liqQueueResult) return liqQueueResult
    if (USE_MOCK_DATA && remainingAmount > 0) return getMockLiqQueueResult(remainingAmount)
    return null
  }, [liqQueueResult, USE_MOCK_DATA, remainingAmount])

  // Use real market sale data if available, otherwise mock in dev
  const effectiveMarketSaleResult = useMemo<MarketSaleSimulationResult | null>(() => {
    if (marketSaleResult) return marketSaleResult
    if (USE_MOCK_DATA && remainingAfterLiqQueue > 0) return getMockMarketSaleResult(remainingAfterLiqQueue)
    return null
  }, [marketSaleResult, USE_MOCK_DATA, remainingAfterLiqQueue])

  // Calculate liquidation filter stages
  const liquidationStages = useMemo<LiquidationStage[]>(() => {
    if (liquidationThreshold <= 0) return []

    const liqQueueFulfilled = effectiveLiqQueueResult?.totalDebtRepaid ?? 0
    const liqQueueCost = effectiveLiqQueueResult?.totalCost ?? 0

    const marketSaleFulfilled = effectiveMarketSaleResult?.totalOutputValue ?? 0
    const marketSaleCost = effectiveMarketSaleResult?.totalSlippageCost ?? 0

    const stages: LiquidationStage[] = [
      {
        name: 'Capital Recall',
        fulfilledAmount: effectiveCapitalRecall.total,
        cost: 0,
        dropdownType: 'capitalRecall',
      },
      {
        name: 'Liquidation Queue',
        fulfilledAmount: liqQueueFulfilled,
        cost: liqQueueCost,
        dropdownType: 'liqQueue',
      },
      {
        name: 'Market Sale',
        fulfilledAmount: marketSaleFulfilled,
        cost: marketSaleCost,
        dropdownType: 'marketSale',
      },
    ]

    return stages
  }, [liquidationThreshold, effectiveCapitalRecall, effectiveLiqQueueResult, effectiveMarketSaleResult])

  // Dropdown helpers
  const getDropdownOpen = (type?: string) => {
    if (type === 'capitalRecall') return capitalRecallOpen
    if (type === 'liqQueue') return liqQueueOpen
    if (type === 'marketSale') return marketSaleOpen
    return false
  }
  const toggleDropdown = (type?: string) => {
    if (type === 'capitalRecall') setCapitalRecallOpen(!capitalRecallOpen)
    if (type === 'liqQueue') setLiqQueueOpen(!liqQueueOpen)
    if (type === 'marketSale') setMarketSaleOpen(!marketSaleOpen)
  }
  const hasDropdownItems = (type?: string) => {
    if (type === 'capitalRecall') return effectiveCapitalRecall.perVenue.length > 0
    if (type === 'liqQueue') return (effectiveLiqQueueResult?.perAsset?.length ?? 0) > 0
    if (type === 'marketSale') return (effectiveMarketSaleResult?.perAsset?.length ?? 0) > 0
    return false
  }

  // Calculate progress percentage for each stage
  const getProgressPercentage = (fulfilledAmount: number) => {
    if (liquidatedAmount <= 0) return 0
    return Math.min(100, num(fulfilledAmount).dividedBy(liquidatedAmount).times(100).toNumber())
  }

  // Show component if we have data (real or mock)
  const hasData = effectiveCollateralValue > 0 && effectiveLiquidationLTV > 0

  if (!hasData) {
    return (
      <Box
        bg="rgba(10, 10, 10, 0.8)"
        borderRadius="lg"
        p={4}
        border="1px solid"
        borderColor="whiteAlpha.200"
      >
        <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
          Liquidation Simulator
        </Text>
        <Text color="whiteAlpha.600" textAlign="center" py={8}>
          No position data available
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
      <VStack spacing={4} align="stretch">
        {/* Title */}
        <Text fontSize="lg" fontWeight="bold" color="white">
          Liquidation Simulator
        </Text>

        {/* Top Metrics Row */}
        <HStack spacing={4} justify="space-between">
          <VStack align="flex-start" spacing={1}>
            <Text color="whiteAlpha.600" fontSize="xs">
              Liquidation Threshold
            </Text>
            <Text color="cyan.400" fontSize="xl" fontWeight="bold">
              ${num(liquidationThreshold).toFixed(2)}
            </Text>
          </VStack>
          <VStack align="flex-end" spacing={1}>
            <Text color="whiteAlpha.600" fontSize="xs">
              Liquidated Amount
            </Text>
            <Text color="white" fontSize="xl" fontWeight="bold">
              ${num(liquidatedAmount).toFixed(2)} CDT
            </Text>
          </VStack>
        </HStack>

        {/* Liquidation Filter Section */}
        <VStack spacing={4} align="stretch" mt={4}>
          <Text color="white" fontSize="sm" fontWeight="semibold">
            Liquidation Filter
          </Text>

          <Table variant="unstyled" size="sm">
            <Thead>
              <Tr>
                <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0}>
                  Stage
                </Th>
                <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} isNumeric>
                  Amount
                </Th>
                <Th color="whiteAlpha.600" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} isNumeric>
                  Cost
                </Th>
              </Tr>
            </Thead>
            <Tbody>
              {liquidationStages.map((stage, index) => {
                const progress = getProgressPercentage(stage.fulfilledAmount)
                const isLast = index === liquidationStages.length - 1
                const dropdownType = stage.dropdownType
                const isOpen = getDropdownOpen(dropdownType)
                const showChevron = hasDropdownItems(dropdownType)

                return (
                  <React.Fragment key={stage.name}>
                    {/* Stage row */}
                    <Tr>
                      <Td px={0} py={3}>
                        <HStack spacing={1}>
                          <Text color="white" fontSize="sm" fontWeight="medium">
                            {stage.name}
                          </Text>
                          {showChevron && (
                            <Box
                              as="button"
                              onClick={() => toggleDropdown(dropdownType)}
                              display="flex"
                              alignItems="center"
                              color="whiteAlpha.600"
                              _hover={{ color: 'white' }}
                              transition="color 0.2s"
                            >
                              <Box
                                as="svg"
                                width="14px"
                                height="14px"
                                viewBox="0 0 16 16"
                                fill="none"
                                transform={isOpen ? 'rotate(180deg)' : 'rotate(0deg)'}
                                transition="transform 0.2s"
                              >
                                <path
                                  d="M4 6L8 10L12 6"
                                  stroke="currentColor"
                                  strokeWidth="2"
                                  strokeLinecap="round"
                                  strokeLinejoin="round"
                                />
                              </Box>
                            </Box>
                          )}
                        </HStack>
                      </Td>
                      <Td px={0} py={3} isNumeric>
                        <Text color="white" fontSize="sm" fontWeight="medium">
                          ${num(stage.fulfilledAmount).toFixed(2)}
                        </Text>
                      </Td>
                      <Td px={0} py={3} isNumeric>
                        <Text
                          color={stage.cost > 0 ? 'red.400' : 'white'}
                          fontSize="sm"
                          fontWeight="medium"
                        >
                          ${num(stage.cost).toFixed(2)}
                        </Text>
                      </Td>
                    </Tr>

                    {/* Capital Recall per-venue dropdown */}
                    {dropdownType === 'capitalRecall' && effectiveCapitalRecall.perVenue.length > 0 && (
                      <Tr>
                        <Td colSpan={3} px={0} py={0}>
                          <Collapse in={capitalRecallOpen} animateOpacity>
                            <Box
                              bg="whiteAlpha.50"
                              borderRadius="md"
                              px={3}
                              py={2}
                              my={1}
                            >
                              <Table variant="unstyled" size="sm">
                                <Thead>
                                  <Tr>
                                    <Th color="whiteAlpha.500" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} py={1}>
                                      Venue
                                    </Th>
                                    <Th color="whiteAlpha.500" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} py={1} isNumeric>
                                      Recalled
                                    </Th>
                                  </Tr>
                                </Thead>
                                <Tbody>
                                  {effectiveCapitalRecall.perVenue.map((venue) => (
                                    <Tr key={venue.address}>
                                      <Td px={0} py={2}>
                                        <Text color="whiteAlpha.800" fontSize="xs" fontWeight="medium" fontFamily="mono">
                                          {getVenueLabel(venue.address)}
                                        </Text>
                                      </Td>
                                      <Td px={0} py={2} isNumeric>
                                        <Text color="whiteAlpha.800" fontSize="xs">
                                          ${num(venue.amount).toFixed(2)}
                                        </Text>
                                      </Td>
                                    </Tr>
                                  ))}
                                </Tbody>
                              </Table>
                            </Box>
                          </Collapse>
                        </Td>
                      </Tr>
                    )}

                    {/* Liquidation Queue per-asset dropdown */}
                    {dropdownType === 'liqQueue' && (effectiveLiqQueueResult?.perAsset?.length ?? 0) > 0 && (
                      <Tr>
                        <Td colSpan={3} px={0} py={0}>
                          <Collapse in={liqQueueOpen} animateOpacity>
                            <Box
                              bg="whiteAlpha.50"
                              borderRadius="md"
                              px={3}
                              py={2}
                              my={1}
                            >
                              <Table variant="unstyled" size="sm">
                                <Thead>
                                  <Tr>
                                    <Th color="whiteAlpha.500" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} py={1}>
                                      Asset
                                    </Th>
                                    <Th color="whiteAlpha.500" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} py={1} isNumeric>
                                      Debt Repaid
                                    </Th>
                                    <Th color="whiteAlpha.500" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} py={1} isNumeric>
                                      Cost
                                    </Th>
                                  </Tr>
                                </Thead>
                                <Tbody>
                                  {effectiveLiqQueueResult!.perAsset.map((asset) => (
                                    <Tr key={asset.denom}>
                                      <Td px={0} py={2}>
                                        <HStack spacing={2}>
                                          <Text color="whiteAlpha.800" fontSize="xs" fontWeight="medium">
                                            {asset.symbol}
                                          </Text>
                                          {asset.logo && (
                                            <Image
                                              src={asset.logo}
                                              w="16px"
                                              h="16px"
                                              borderRadius="full"
                                            />
                                          )}
                                        </HStack>
                                      </Td>
                                      <Td px={0} py={2} isNumeric>
                                        <Text color="whiteAlpha.800" fontSize="xs">
                                          ${num(asset.debtRepaid).toFixed(2)}
                                        </Text>
                                      </Td>
                                      <Td px={0} py={2} isNumeric>
                                        <Text
                                          color={asset.cost > 0 ? 'red.300' : 'whiteAlpha.800'}
                                          fontSize="xs"
                                        >
                                          ${num(asset.cost).toFixed(2)}
                                        </Text>
                                      </Td>
                                    </Tr>
                                  ))}
                                </Tbody>
                              </Table>
                            </Box>
                          </Collapse>
                        </Td>
                      </Tr>
                    )}

                    {/* Market Sale per-asset dropdown with routes */}
                    {dropdownType === 'marketSale' && (effectiveMarketSaleResult?.perAsset?.length ?? 0) > 0 && (
                      <Tr>
                        <Td colSpan={3} px={0} py={0}>
                          <Collapse in={marketSaleOpen} animateOpacity>
                            <Box
                              bg="whiteAlpha.50"
                              borderRadius="md"
                              px={3}
                              py={2}
                              my={1}
                            >
                              <Table variant="unstyled" size="sm">
                                <Thead>
                                  <Tr>
                                    <Th color="whiteAlpha.500" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} py={1}>
                                      Asset
                                    </Th>
                                    <Th color="whiteAlpha.500" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} py={1} isNumeric>
                                      Output
                                    </Th>
                                    <Th color="whiteAlpha.500" fontSize="xs" fontWeight="normal" textTransform="uppercase" px={0} py={1} isNumeric>
                                      Slippage
                                    </Th>
                                  </Tr>
                                </Thead>
                                <Tbody>
                                  {effectiveMarketSaleResult!.perAsset.map((asset, idx) => (
                                    <React.Fragment key={asset.denom}>
                                      <Tr>
                                        <Td px={0} py={2}>
                                          <HStack spacing={2}>
                                            <Text color="whiteAlpha.800" fontSize="xs" fontWeight="medium">
                                              {asset.symbol}
                                            </Text>
                                            {asset.logo && (
                                              <Image
                                                src={asset.logo}
                                                w="16px"
                                                h="16px"
                                                borderRadius="full"
                                              />
                                            )}
                                          </HStack>
                                        </Td>
                                        <Td px={0} py={2} isNumeric>
                                          <Text color="whiteAlpha.800" fontSize="xs">
                                            ${num(asset.outputValue).toFixed(2)}
                                          </Text>
                                        </Td>
                                        <Td px={0} py={2} isNumeric>
                                          <Text color="red.300" fontSize="xs">
                                            ${num(asset.slippageCost).toFixed(2)}
                                          </Text>
                                        </Td>
                                      </Tr>
                                      {/* Show routes if available */}
                                      {asset.routes && asset.routes.length > 0 && (
                                        <Tr>
                                          <Td colSpan={3} px={2} py={1}>
                                            <VStack align="flex-start" spacing={1}>
                                              <Text color="whiteAlpha.400" fontSize="2xs" fontWeight="medium">
                                                Route:
                                              </Text>
                                              {asset.routes.map((hop, hopIdx) => (
                                                <HStack key={hopIdx} spacing={1}>
                                                  <Text color="whiteAlpha.600" fontSize="2xs" fontFamily="mono">
                                                    {hop.symbol || hop.tokenIn} → {hopIdx === asset.routes.length - 1 ? 'CDT' : asset.routes[hopIdx + 1]?.symbol || ''}
                                                  </Text>
                                                  <Text color="whiteAlpha.400" fontSize="2xs">
                                                    ({hop.dex})
                                                  </Text>
                                                </HStack>
                                              ))}
                                            </VStack>
                                          </Td>
                                        </Tr>
                                      )}
                                    </React.Fragment>
                                  ))}
                                </Tbody>
                              </Table>
                              {/* Asterisk note */}
                              {effectiveMarketSaleResult?.asteriskNote && (
                                <Text color="whiteAlpha.400" fontSize="2xs" fontStyle="italic" mt={2}>
                                  {effectiveMarketSaleResult.asteriskNote}
                                </Text>
                              )}
                            </Box>
                          </Collapse>
                        </Td>
                      </Tr>
                    )}

                    {/* Progress bar */}
                    <Tr>
                      <Td colSpan={3} px={0} py={2}>
                        <Box position="relative" w="100%" h="8px" bg="whiteAlpha.100" borderRadius="full" overflow="hidden">
                          <Box
                            h="100%"
                            bg="#6943FF"
                            borderRadius="full"
                            w={`${progress}%`}
                            opacity={Math.max(0.3, Math.min(1, 0.3 + (progress / 100) * 0.7))}
                            transition="width 0.2s, opacity 0.2s"
                          />
                        </Box>
                      </Td>
                    </Tr>
                    {!isLast && (
                      <Tr>
                        <Td colSpan={3} px={0} py={2}>
                          <Box display="flex" justifyContent="center">
                            <Box
                              as="svg"
                              width="16px"
                              height="16px"
                              viewBox="0 0 16 16"
                              fill="none"
                            >
                              <path
                                d="M8 2L8 14M8 14L12 10M8 14L4 10"
                                stroke="rgba(255, 255, 255, 0.4)"
                                strokeWidth="2"
                                strokeLinecap="round"
                                strokeLinejoin="round"
                              />
                            </Box>
                          </Box>
                        </Td>
                      </Tr>
                    )}
                  </React.Fragment>
                )
              })}
            </Tbody>
          </Table>
        </VStack>

        {/* Subtitle */}
        <Text color="whiteAlpha.500" fontSize="xs" textAlign="right" fontStyle="italic">
          Protocol doesn't profit from liquidations
        </Text>
      </VStack>
    </Box>
  )
}

export default LiquidationSimulator
