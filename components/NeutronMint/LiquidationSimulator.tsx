import React from 'react'
import { HStack, VStack, Text } from '@chakra-ui/react'
import { Card } from '@/components/ui/Card'
import { num } from '@/helpers/num'
import { PositionResponse } from '@/contracts/codegen/positions/Positions.types'
import { useLiquidationSimData } from './hooks/useLiquidationSimData'
import { LiquidationSimFilterTable } from './LiquidationSimFilterTable'

interface LiquidationSimulatorProps {
  collateralValue: number
  liquidationLTV: number
  borrowLTV: number
  positionIndex?: number
  position?: PositionResponse
  userAddress?: string
}

interface LiquidationSimMetricsProps {
  liquidationThreshold: number
  liquidatedAmount: number
}

const LiquidationSimMetrics: React.FC<LiquidationSimMetricsProps> = ({
  liquidationThreshold,
  liquidatedAmount,
}) => (
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
)

export const LiquidationSimulator: React.FC<LiquidationSimulatorProps> = ({
  collateralValue,
  liquidationLTV,
  borrowLTV,
  position,
  userAddress,
}) => {
  const {
    hasData,
    liquidationThreshold,
    liquidatedAmount,
    effectiveCapitalRecall,
    effectiveLiqQueueResult,
    effectiveMarketSaleResult,
    liquidationStages,
  } = useLiquidationSimData({
    collateralValue,
    liquidationLTV,
    borrowLTV,
    position,
    userAddress,
  })

  if (!hasData) {
    return (
      <Card p={4}>
        <Text fontSize="lg" fontWeight="bold" mb={4} color="white">
          Liquidation Simulator
        </Text>
        <Text color="whiteAlpha.600" textAlign="center" py={8}>
          No position data available
        </Text>
      </Card>
    )
  }

  return (
    <Card p={4}>
      <VStack spacing={4} align="stretch">
        {/* Title */}
        <Text fontSize="lg" fontWeight="bold" color="white">
          Liquidation Simulator
        </Text>

        {/* Top Metrics Row */}
        <LiquidationSimMetrics
          liquidationThreshold={liquidationThreshold}
          liquidatedAmount={liquidatedAmount}
        />

        {/* Liquidation Filter Section */}
        <LiquidationSimFilterTable
          liquidatedAmount={liquidatedAmount}
          liquidationStages={liquidationStages}
          effectiveCapitalRecall={effectiveCapitalRecall}
          effectiveLiqQueueResult={effectiveLiqQueueResult}
          effectiveMarketSaleResult={effectiveMarketSaleResult}
        />

        {/* Subtitle */}
        <Text color="whiteAlpha.500" fontSize="xs" textAlign="right" fontStyle="italic">
          Protocol doesn&apos;t profit from liquidations
        </Text>
      </VStack>
    </Card>
  )
}

export default LiquidationSimulator
