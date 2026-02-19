import React, { useMemo } from 'react'
import { Box, HStack, Text, Tooltip } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { SimTick, SimPhase } from './engine/types'

const PHASE_COLORS: Record<SimPhase, string> = {
  awaiting: 'rgba(255, 255, 255, 0.15)',
  deposit: '#22d3ee',
  withdrawal: '#fbbf24',
  'post-withdrawal': '#A692FF',
  cliff: 'rgba(255, 255, 255, 0.25)',
}

const PHASE_LABELS: Record<SimPhase, string> = {
  awaiting: 'Awaiting',
  deposit: 'Deposit Period',
  withdrawal: 'Withdrawal',
  'post-withdrawal': 'Post-Withdrawal',
  cliff: 'Cliff',
}

interface SimPhaseTimelineProps {
  ticks: SimTick[]
  cursorDay: number | null
}

interface PhaseSegment {
  phase: SimPhase
  startDay: number
  endDay: number
}

export const SimPhaseTimeline: React.FC<SimPhaseTimelineProps> = ({
  ticks,
  cursorDay,
}) => {
  const { segments, totalDays } = useMemo(() => {
    if (ticks.length === 0) return { segments: [], totalDays: 0 }

    const result: PhaseSegment[] = []
    let currentPhase = ticks[0].phase
    let startDay = ticks[0].day

    for (let i = 1; i < ticks.length; i++) {
      if (ticks[i].phase !== currentPhase) {
        result.push({ phase: currentPhase, startDay, endDay: ticks[i].day })
        currentPhase = ticks[i].phase
        startDay = ticks[i].day
      }
    }
    // Push final segment
    result.push({
      phase: currentPhase,
      startDay,
      endDay: ticks[ticks.length - 1].day,
    })

    return { segments: result, totalDays: ticks[ticks.length - 1].day }
  }, [ticks])

  if (segments.length === 0) return null

  return (
    <Box>
      {/* Phase bar */}
      <HStack spacing={0} h="28px" borderRadius="6px" overflow="hidden">
        {segments.map((seg, i) => {
          const widthPct =
            ((seg.endDay - seg.startDay) / totalDays) * 100
          if (widthPct < 0.5) return null

          return (
            <Tooltip
              key={i}
              label={`${PHASE_LABELS[seg.phase]}: Day ${seg.startDay.toFixed(1)} – ${seg.endDay.toFixed(1)}`}
              placement="top"
              hasArrow
            >
              <Box
                h="100%"
                w={`${widthPct}%`}
                bg={PHASE_COLORS[seg.phase]}
                opacity={0.6}
                position="relative"
                _hover={{ opacity: 0.9 }}
                transition="opacity 0.15s"
              >
                {/* Phase label if wide enough */}
                {widthPct > 12 && (
                  <Text
                    position="absolute"
                    top="50%"
                    left="50%"
                    transform="translate(-50%, -50%)"
                    fontSize={TYPOGRAPHY.xs}
                    fontWeight={TYPOGRAPHY.medium}
                    color="rgba(0, 0, 0, 0.8)"
                    whiteSpace="nowrap"
                    userSelect="none"
                  >
                    {PHASE_LABELS[seg.phase]}
                  </Text>
                )}
              </Box>
            </Tooltip>
          )
        })}
      </HStack>

      {/* Cursor indicator */}
      {cursorDay !== null && totalDays > 0 && (
        <Box position="relative" h="4px" mt="2px">
          <Box
            position="absolute"
            left={`${(cursorDay / totalDays) * 100}%`}
            top="-2px"
            w="2px"
            h="8px"
            bg="white"
            borderRadius="1px"
            transform="translateX(-50%)"
          />
        </Box>
      )}

      {/* Day labels */}
      <HStack justify="space-between" mt={SPACING.xs}>
        <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
          Day 0
        </Text>
        <Text fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary}>
          Day {totalDays.toFixed(0)}
        </Text>
      </HStack>
    </Box>
  )
}
