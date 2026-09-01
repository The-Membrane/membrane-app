import React, { useState } from 'react'
import { Box, VStack, Text, Table, Thead, Tbody, Tr, Th, Collapse } from '@chakra-ui/react'
import { num } from '@/helpers/num'
import { CapitalRecallResult } from './hooks/useCapitalRecall'
import { LiqQueueSimulationResult } from './hooks/useLiquidationQueueSimulation'
import { MarketSaleSimulationResult } from './hooks/useMarketSaleSimulation'
import { LiquidationStage } from './hooks/useLiquidationSimData'
import { LiquidationSimStageRow } from './LiquidationSimStageRow'

interface LiquidationSimFilterTableProps {
  liquidatedAmount: number
  liquidationStages: LiquidationStage[]
  effectiveCapitalRecall: CapitalRecallResult
  effectiveLiqQueueResult: LiqQueueSimulationResult | null
  effectiveMarketSaleResult: MarketSaleSimulationResult | null
}

export const LiquidationSimFilterTable: React.FC<LiquidationSimFilterTableProps> = ({
  liquidatedAmount,
  liquidationStages,
  effectiveCapitalRecall,
  effectiveLiqQueueResult,
  effectiveMarketSaleResult,
}) => {
  const [filterOpen, setFilterOpen] = useState(false)
  const [capitalRecallOpen, setCapitalRecallOpen] = useState(false)
  const [liqQueueOpen, setLiqQueueOpen] = useState(false)
  const [marketSaleOpen, setMarketSaleOpen] = useState(false)

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

  return (
    <VStack spacing={0} align="stretch" mt={4}>
      {/* Centered chevron toggle */}
      <Box
        as="button"
        onClick={() => setFilterOpen(!filterOpen)}
        display="flex"
        flexDirection="column"
        alignItems="center"
        justifyContent="center"
        py={2}
        cursor="pointer"
        color="whiteAlpha.500"
        _hover={{ color: 'white' }}
        transition="color 0.2s"
      >
        <Box
          as="svg"
          width="20px"
          height="20px"
          viewBox="0 0 16 16"
          fill="none"
          transform={filterOpen ? 'rotate(180deg)' : 'rotate(0deg)'}
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

      <Collapse in={filterOpen} animateOpacity>
      <Text color="white" fontSize="sm" fontWeight="semibold" mb={2}>
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
              <LiquidationSimStageRow
                key={stage.name}
                stage={stage}
                progress={progress}
                isLast={isLast}
                isOpen={isOpen}
                showChevron={showChevron}
                onToggle={() => toggleDropdown(dropdownType)}
                effectiveCapitalRecall={effectiveCapitalRecall}
                effectiveLiqQueueResult={effectiveLiqQueueResult}
                effectiveMarketSaleResult={effectiveMarketSaleResult}
              />
            )
          })}
        </Tbody>
      </Table>
      </Collapse>
    </VStack>
  )
}

export default LiquidationSimFilterTable
