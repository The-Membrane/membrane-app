import React from 'react'
import { Box, VStack } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { useAcquisitionDashboardData } from './hooks'
import { HexBackground } from './HexBackground'
import { DashboardHeader } from './DashboardHeader'
import { SupplySection } from './SupplySection'
import { WindowStatsSection } from './WindowStatsSection'
import { PhaseTimelineSection } from './PhaseTimelineSection'
import { HistoryChartsSection } from './HistoryChartsSection'
import { MetricsSection } from './MetricsSection'

/* ── Main dashboard ── */
export const AcquisitionDashboard: React.FC = () => {
  const {
    supplyChartData,
    phase,
    totalDeposits,
    depositorCount,
    timelineSegments,
    historyChartData,
    windowStats,
    acquisitionLoading,
  } = useAcquisitionDashboardData()

  return (
    <Box position="relative" w="100%" minH="100vh" bg={SEMANTIC_COLORS.bgPrimary}>
      {/* Hexagonal Background Grid */}
      <HexBackground />

      <Box w="100%" maxW="1400px" mx="auto" p={{ base: 4, md: 8 }} pt={{ base: 24, md: 28 }} position="relative" zIndex={1}>
        <VStack spacing={SPACING.xl} align="stretch">
          {/* Page header */}
          <DashboardHeader />

          {/* ── MBRN Supply Over Time (top-line chart) ── */}
          <SupplySection data={supplyChartData} />

          {/* ── Current Window Stats Overview ── */}
          {windowStats && <WindowStatsSection windowStats={windowStats} />}

          {/* ── Lockdrop Phase Timeline ── */}
          <PhaseTimelineSection phase={phase} timelineSegments={timelineSegments} windowStats={windowStats} />

          {/* ── Acquisition History Charts ── */}
          {historyChartData.length > 0 && <HistoryChartsSection data={historyChartData} />}

          {/* ── Acquisition Metrics ── */}
          <MetricsSection
            acquisitionLoading={acquisitionLoading}
            totalDeposits={totalDeposits}
            depositorCount={depositorCount}
          />
        </VStack>
      </Box>
    </Box>
  )
}

export default AcquisitionDashboard
