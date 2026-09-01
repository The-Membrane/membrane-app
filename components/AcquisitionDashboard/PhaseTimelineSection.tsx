import React from 'react'
import { Box, VStack, Text, HStack, Tooltip } from '@chakra-ui/react'
import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TRANSITIONS } from '@/config/transitions'
import { Card } from '@/components/ui/Card'
import { PRIMARY_PURPLE, PHASE_COLORS, PHASE_LABELS, LockdropPhase } from './constants'
import type { AcquisitionDashboardData } from './hooks'

/* ── Lockdrop Phase Timeline ── */
export const PhaseTimelineSection: React.FC<{
  phase: LockdropPhase
  timelineSegments: AcquisitionDashboardData['timelineSegments']
  windowStats: AcquisitionDashboardData['windowStats']
}> = ({ phase, timelineSegments, windowStats }) => (
  <VStack spacing={SPACING.md} align="stretch">
    <Text
      fontSize="sm"
      fontWeight="bold"
      color={PRIMARY_PURPLE}
      fontFamily="mono"
      letterSpacing="1px"
      textTransform="uppercase"
    >
      Acquisition Phase
    </Text>
    <Card variant="subtle" p={4} borderRadius={0}>
      {/* Current phase badge */}
      <HStack mb={3} spacing={3}>
        <Box
          px={3}
          py={1}
          borderRadius={0}
          bg={`${PHASE_COLORS[phase]}30`}
          border="1px solid"
          borderColor={PHASE_COLORS[phase]}
        >
          <Text
            fontSize="xs"
            fontFamily="mono"
            fontWeight="bold"
            color={PHASE_COLORS[phase]}
            letterSpacing="1px"
            textTransform="uppercase"
          >
            {PHASE_LABELS[phase]}
          </Text>
        </Box>
      </HStack>

      {/* Phase bar with date markers */}
      {timelineSegments ? (
        <Box>
          {/* Bar */}
          <HStack spacing={0} h="28px" borderRadius={0} overflow="hidden">
            <Tooltip label="Deposit Period" placement="top" hasArrow>
              <Box
                h="100%"
                w={`${timelineSegments.depositPct}%`}
                bg={PHASE_COLORS.deposit}
                opacity={0.6}
                _hover={{ opacity: 0.9 }}
                transition={TRANSITIONS.opacityQuick}
              />
            </Tooltip>
            <Tooltip label="Withdrawal Period" placement="top" hasArrow>
              <Box
                h="100%"
                w={`${timelineSegments.withdrawalPct}%`}
                bg={PHASE_COLORS.withdrawal}
                opacity={0.6}
                _hover={{ opacity: 0.9 }}
                transition={TRANSITIONS.opacityQuick}
              />
            </Tooltip>
          </HStack>
          {/* Progress indicator */}
          <Box position="relative" h="4px" mt="2px">
            <Box
              position="absolute"
              left={`${timelineSegments.progressPct}%`}
              top="-2px"
              w="2px"
              h="8px"
              bg={SEMANTIC_COLORS.textPrimary}
              borderRadius={0}
              transform="translateX(-50%)"
            />
          </Box>
          {/* Date markers positioned along the bar */}
          <Box position="relative" h="32px" mt={1}>
            {/* Start date — left edge */}
            <Box position="absolute" left="0" textAlign="left">
              <Text fontSize="10px" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono" lineHeight="1.2">
                Start
              </Text>
              <Text fontSize="10px" color={PHASE_COLORS.deposit} fontFamily="mono" fontWeight="bold" lineHeight="1.2">
                {windowStats?.startTime ?? '—'}
              </Text>
            </Box>
            {/* Deposit end — at boundary between deposit/withdrawal */}
            <Box
              position="absolute"
              left={`${timelineSegments.depositPct}%`}
              transform="translateX(-50%)"
              textAlign="center"
            >
              <Text fontSize="10px" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono" lineHeight="1.2">
                Deposit End
              </Text>
              <Text fontSize="10px" color={PHASE_COLORS.withdrawal} fontFamily="mono" fontWeight="bold" lineHeight="1.2">
                {windowStats?.depositEnd ?? '—'}
              </Text>
            </Box>
            {/* Withdrawal end — right edge */}
            <Box position="absolute" right="0" textAlign="right">
              <Text fontSize="10px" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono" lineHeight="1.2">
                Withdrawal End
              </Text>
              <Text fontSize="10px" color={PHASE_COLORS['claims-ready']} fontFamily="mono" fontWeight="bold" lineHeight="1.2">
                {windowStats?.withdrawalEnd ?? '—'}
              </Text>
            </Box>
          </Box>
        </Box>
      ) : (
        <Text fontSize="xs" color={SEMANTIC_COLORS.textSecondary} fontFamily="mono">
          No active acquisition window
        </Text>
      )}
    </Card>
  </VStack>
)
