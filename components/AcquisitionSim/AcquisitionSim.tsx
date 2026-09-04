import React, { useState, useMemo, useCallback } from 'react'
import {
  Box,
  Flex,
  VStack,
  Text,
  useBreakpointValue,
} from '@chakra-ui/react'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { PageTitle } from '@/components/ui/PageTitle'
import type { SimConfig, SimEvent, UtilizationPoint } from './engine/types'
import { DEFAULT_CONFIG } from './engine/types'
import { runSimulation } from './engine/simulate'
import { PRESETS } from './presets'
import { SimControls } from './SimControls'
import { SimCharts } from './SimCharts'
import { SimStateCards } from './SimStateCards'
import { SimPhaseTimeline } from './SimPhaseTimeline'

export const AcquisitionSim: React.FC = () => {
  // ── State ──
  const [config, setConfig] = useState<SimConfig>({
    ...DEFAULT_CONFIG,
    ...PRESETS[0].config,
  })
  const [events, setEvents] = useState<SimEvent[]>([...PRESETS[0].events])
  const [utilizationCurve, setUtilizationCurve] = useState<UtilizationPoint[]>(
    [...PRESETS[0].utilizationCurve]
  )
  const [cursorDay, setCursorDay] = useState<number | null>(null)

  // ── Run simulation ──
  const ticks = useMemo(
    () => runSimulation(config, events, utilizationCurve),
    [config, events, utilizationCurve]
  )

  // ── Callbacks ──
  const handleConfigChange = useCallback((c: SimConfig) => setConfig(c), [])
  const handleEventsChange = useCallback((e: SimEvent[]) => setEvents(e), [])
  const handleUtilChange = useCallback(
    (u: UtilizationPoint[]) => setUtilizationCurve(u),
    []
  )
  const handleCursorChange = useCallback(
    (day: number | null) => setCursorDay(day),
    []
  )

  // ── Responsive layout ──
  const sidebarWidth = useBreakpointValue({ base: '100%', xl: '320px' })
  const isStacked = useBreakpointValue({ base: true, xl: false })

  return (
    <Box minH="100vh" bg={SEMANTIC_COLORS.bgPrimary} position="relative">
      {/* Background gradients */}
      <Box
        position="absolute"
        inset={0}
        pointerEvents="none"
        bg="radial-gradient(circle at 20% 30%, rgba(155, 220, 79, 0.06) 0%, transparent 50%),
            radial-gradient(circle at 80% 70%, rgba(70, 211, 154, 0.06) 0%, transparent 50%)"
      />

      <Box position="relative" zIndex={1}>
        {/* Header */}
        <Box
          px={SPACING_PATTERNS.cardPadding}
          pt={SPACING.lg}
          pb={SPACING.base}
        >
          <PageTitle
            title="Acquisition Simulator"
            subtitle="Control System Simulation"
            subtitleColor={SEMANTIC_COLORS.textSecondary}
            mb={0}
          />
          <Text
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textTertiary}
            mt={SPACING.xs}
          >
            {ticks.length} ticks simulated ({ticks.length > 0 ? ticks[ticks.length - 1].day.toFixed(0) : 0} days)
          </Text>
        </Box>

        {/* Main layout */}
        <Flex
          direction={isStacked ? 'column' : 'row'}
          px={SPACING_PATTERNS.cardPadding}
          pb={SPACING.xl}
          gap={SPACING_PATTERNS.sectionGap}
        >
          {/* Sidebar: Controls */}
          <Box
            w={sidebarWidth}
            flexShrink={0}
            bg={SEMANTIC_COLORS.bgSecondary}
            borderRadius={0}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            p={SPACING_PATTERNS.cardPadding}
            maxH={isStacked ? 'none' : 'calc(100vh - 140px)'}
            overflowY="auto"
            css={{
              '&::-webkit-scrollbar': { width: '6px' },
              '&::-webkit-scrollbar-track': { background: 'transparent' },
              '&::-webkit-scrollbar-thumb': {
                background: SEMANTIC_COLORS.borderStrong,
                borderRadius: 0,
              },
            }}
          >
            <SimControls
              config={config}
              events={events}
              utilizationCurve={utilizationCurve}
              onConfigChange={handleConfigChange}
              onEventsChange={handleEventsChange}
              onUtilizationChange={handleUtilChange}
            />
          </Box>

          {/* Main: Charts + State */}
          <VStack flex={1} spacing={SPACING_PATTERNS.sectionGap} align="stretch" minW={0}>
            {/* Phase timeline */}
            <SimPhaseTimeline ticks={ticks} cursorDay={cursorDay} />

            {/* State cards */}
            <SimStateCards ticks={ticks} cursorDay={cursorDay} />

            {/* Charts grid */}
            <SimCharts
              ticks={ticks}
              config={config}
              onCursorChange={handleCursorChange}
            />
          </VStack>
        </Flex>
      </Box>
    </Box>
  )
}

export default AcquisitionSim
