import React from 'react'
import { Box, VStack, HStack, Text, Table, Thead, Tbody, Tr, Th, Td, Image, Collapse } from '@chakra-ui/react'
import { num } from '@/helpers/num'
import { getVenueLabel } from '@/config/venueLabels'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { CapitalRecallResult } from './hooks/useCapitalRecall'
import { LiqQueueSimulationResult } from './hooks/useLiquidationQueueSimulation'
import { MarketSaleSimulationResult } from './hooks/useMarketSaleSimulation'
import { LiquidationStage } from './hooks/useLiquidationSimData'

interface LiquidationSimCapitalRecallDropdownProps {
  isOpen: boolean
  perVenue: CapitalRecallResult['perVenue']
}

// Capital Recall per-venue dropdown
export const LiquidationSimCapitalRecallDropdown: React.FC<LiquidationSimCapitalRecallDropdownProps> = ({
  isOpen,
  perVenue,
}) => (
  <Tr>
    <Td colSpan={3} px={0} py={0}>
      <Collapse in={isOpen} animateOpacity>
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
              {perVenue.map((venue) => (
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
)

interface LiquidationSimLiqQueueDropdownProps {
  isOpen: boolean
  result: LiqQueueSimulationResult
}

// Liquidation Queue per-asset dropdown
export const LiquidationSimLiqQueueDropdown: React.FC<LiquidationSimLiqQueueDropdownProps> = ({
  isOpen,
  result,
}) => (
  <Tr>
    <Td colSpan={3} px={0} py={0}>
      <Collapse in={isOpen} animateOpacity>
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
              {result.perAsset.map((asset) => (
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
)

interface LiquidationSimMarketSaleDropdownProps {
  isOpen: boolean
  result: MarketSaleSimulationResult
}

// Market Sale per-asset dropdown with routes
export const LiquidationSimMarketSaleDropdown: React.FC<LiquidationSimMarketSaleDropdownProps> = ({
  isOpen,
  result,
}) => (
  <Tr>
    <Td colSpan={3} px={0} py={0}>
      <Collapse in={isOpen} animateOpacity>
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
              {result.perAsset.map((asset, idx) => (
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
          {result.asteriskNote && (
            <Text color="whiteAlpha.400" fontSize="2xs" fontStyle="italic" mt={2}>
              {result.asteriskNote}
            </Text>
          )}
        </Box>
      </Collapse>
    </Td>
  </Tr>
)

interface LiquidationSimStageRowProps {
  stage: LiquidationStage
  progress: number
  isLast: boolean
  isOpen: boolean
  showChevron: boolean
  onToggle: () => void
  effectiveCapitalRecall: CapitalRecallResult
  effectiveLiqQueueResult: LiqQueueSimulationResult | null
  effectiveMarketSaleResult: MarketSaleSimulationResult | null
}

export const LiquidationSimStageRow: React.FC<LiquidationSimStageRowProps> = ({
  stage,
  progress,
  isLast,
  isOpen,
  showChevron,
  onToggle,
  effectiveCapitalRecall,
  effectiveLiqQueueResult,
  effectiveMarketSaleResult,
}) => {
  const dropdownType = stage.dropdownType

  return (
    <React.Fragment>
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
                onClick={onToggle}
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
        <LiquidationSimCapitalRecallDropdown isOpen={isOpen} perVenue={effectiveCapitalRecall.perVenue} />
      )}

      {/* Liquidation Queue per-asset dropdown */}
      {dropdownType === 'liqQueue' && (effectiveLiqQueueResult?.perAsset?.length ?? 0) > 0 && (
        <LiquidationSimLiqQueueDropdown isOpen={isOpen} result={effectiveLiqQueueResult!} />
      )}

      {/* Market Sale per-asset dropdown with routes */}
      {dropdownType === 'marketSale' && (effectiveMarketSaleResult?.perAsset?.length ?? 0) > 0 && (
        <LiquidationSimMarketSaleDropdown isOpen={isOpen} result={effectiveMarketSaleResult!} />
      )}

      {/* Progress bar */}
      <Tr>
        <Td colSpan={3} px={0} py={2}>
          <Box position="relative" w="100%" h="8px" bg="whiteAlpha.100" borderRadius="full" overflow="hidden">
            <Box
              h="100%"
              bg={SEMANTIC_COLORS.primary}
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
}

export default LiquidationSimStageRow
