// Run bar: the fifteen-floor strip (green held / gold hurt / red would-have-killed),
// unlocked-floor drilling, and the floor/net/kept stats. Proto: .runbar markup (:488-498)
// + paintFloors (:1355).

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { tabular } from './styles'
import { usd } from './utils'
import { FloorMark, RunState, Scenario } from './types'

export interface RunBarProps {
  scenarios: Scenario[]
  run: RunState
  practice: number
  maxReached: number
  rFloorLabel: string
  netMade: number
  runHint: string
  onDrill: (i: number) => void
}

export const RunBar: React.FC<RunBarProps> = ({ scenarios, run, practice, maxReached, rFloorLabel, netMade, runHint, onDrill }) => (
  <Box
    mt={SPACING.sm}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderStrong}
    bg={SEMANTIC_COLORS.bgSecondary}
    display="grid"
    gridTemplateColumns={{ base: '1fr', md: '1fr auto' }}
    gap={SPACING.md}
    px={SPACING.base}
    py={SPACING.md}
    alignItems="center"
  >
    <Box>
      <Box display="flex" gap="5px" flexWrap="wrap">
        {scenarios.map((sc, i) => {
          const mk: FloorMark = (run.marks || [])[i]
          const now = practice === i || (run.active && i === run.floor)
          const open = i <= maxReached && !run.active
          const style =
            mk === 'dead'
              ? { borderColor: SEMANTIC_COLORS.danger, color: SEMANTIC_COLORS.bgPrimary, bg: SEMANTIC_COLORS.danger }
              : mk === 'hurt'
                ? { borderColor: SEMANTIC_COLORS.warning, color: SEMANTIC_COLORS.bgPrimary, bg: SEMANTIC_COLORS.warning }
                : mk === 'clean'
                  ? { borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.bgPrimary, bg: SEMANTIC_COLORS.success }
                  : now
                    ? { borderColor: SEMANTIC_COLORS.warning, color: SEMANTIC_COLORS.warning, bg: 'none' }
                    : { borderColor: SEMANTIC_COLORS.borderStrong, color: SEMANTIC_COLORS.textTertiary, bg: 'none' }
          return (
            <Box
              key={i}
              as="button"
              type="button"
              disabled={!open}
              title={open ? sc.n + ' — drill this floor' : 'locked — reach it in a run first'}
              onClick={() => onDrill(i)}
              w="26px"
              h="26px"
              border="1px solid"
              display="grid"
              placeItems="center"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="9.5px"
              {...tabular}
              borderRadius={0}
              p={0}
              cursor={open ? 'pointer' : 'not-allowed'}
              opacity={open || mk || now ? 1 : 0.35}
              transition={TRANSITIONS.colors}
              _hover={open && !mk ? { borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success } : undefined}
              _focusVisible={FOCUS_STYLES.ring}
              {...style}
            >
              {i + 1}
            </Box>
          )
        })}
      </Box>
      <Text mt={SPACING.sm} fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
        {runHint}
      </Text>
    </Box>
    <Box display="flex" gap={SPACING.base} flexWrap="wrap" alignItems="baseline">
      <Box display="grid" gap="1px">
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
          Floor
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="17px" color={SEMANTIC_COLORS.textPrimary} {...tabular}>
          {rFloorLabel}
        </Text>
      </Box>
      <Box display="grid" gap="1px">
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
          Net made
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="17px" {...tabular} color={netMade >= 0 ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.danger}>
          {(netMade >= 0 ? '+' : '') + usd(netMade)}
        </Text>
      </Box>
      <Box display="grid" gap="1px">
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" letterSpacing="0.2em" textTransform="uppercase" color={SEMANTIC_COLORS.textSecondary}>
          Bitcoin kept
        </Text>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="17px" color={SEMANTIC_COLORS.textPrimary} {...tabular}>
          {run.btc.toFixed(3)} BTC
        </Text>
      </Box>
    </Box>
  </Box>
)

export default RunBar
