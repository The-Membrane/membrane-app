import React from 'react'
import { Box, VStack, Text, HStack } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { ASSET_COLORS } from '@/config/chartTheme'
import { Card } from '@/components/ui/Card'
import { PRIMARY_PURPLE } from './constants'
import { ChartInfo } from './ChartInfo'
import { UtilizationRateChart, AccruedPoolChart } from './charts'

/* ── Acquisition History Charts ── */
export const HistoryChartsSection: React.FC<{ data: any[] }> = ({ data }) => (
  <VStack spacing={SPACING.md} align="stretch">
    <Text
      fontSize="sm"
      fontWeight="bold"
      color={PRIMARY_PURPLE}
      fontFamily="mono"
      letterSpacing="1px"
      textTransform="uppercase"
    >
      Acquisition Control System History
    </Text>

    {/* Utilization + Acquisition Rate + Bump Rate chart */}
    <Card variant="subtle" p={4} borderRadius={0}>
      <HStack spacing={2} mb={2}>
        <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono" letterSpacing="1px">
          Utilization, Acquisition Rate & Bump Rate
        </Text>
        <ChartInfo tip="Utilization (left axis): transmuter usage %, drives rate adjustments. Acquisition Rate (right axis): MBRN emitted per second into the accrued pool. Bump Rate (right axis): additional rate sent to CDP when utilization exceeds target." />
      </HStack>
      <UtilizationRateChart data={data} />
      <HStack justify="center" mt={2} spacing={6}>
        <HStack spacing={2}>
          <Box w="12px" h="3px" bg={ASSET_COLORS[0]} borderRadius={0} />
          <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono">Utilization</Text>
        </HStack>
        <HStack spacing={2}>
          <Box w="12px" h="3px" bg={ASSET_COLORS[1]} borderRadius={0} />
          <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono">Acquisition Rate</Text>
        </HStack>
        <HStack spacing={2}>
          <Box w="12px" h="3px" bg={ASSET_COLORS[2]} borderRadius={0} />
          <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono">Bump Rate</Text>
        </HStack>
      </HStack>
    </Card>

    {/* Accrued Pool + New Deposits + Efficiency chart */}
    <Card variant="subtle" p={4} borderRadius={0}>
      <HStack spacing={2} mb={2}>
        <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono" letterSpacing="1px">
          Accrued Pool, New Deposits & Efficiency
        </Text>
        <ChartInfo tip="Accrued Pool (left axis): total MBRN accumulated from emissions. New Deposits (left axis): cumulative new CDT deposited this window. Efficiency (right axis): new deposits / accrued pool %. If too low at withdrawal end, the budget may be clamped." />
      </HStack>
      <AccruedPoolChart data={data} />
      <HStack justify="center" mt={2} spacing={6}>
        <HStack spacing={2}>
          <Box w="12px" h="3px" bg={ASSET_COLORS[0]} borderRadius={0} />
          <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono">Accrued Pool (MBRN)</Text>
        </HStack>
        <HStack spacing={2}>
          <Box w="12px" h="3px" bg={ASSET_COLORS[1]} borderRadius={0} />
          <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono">New Deposits (CDT)</Text>
        </HStack>
        <HStack spacing={2}>
          <Box w="12px" h="3px" bg={ASSET_COLORS[2]} borderRadius={0} />
          <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono">Efficiency (%)</Text>
        </HStack>
      </HStack>
    </Card>
  </VStack>
)
