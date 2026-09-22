// The receipt: every liquidation, recall and cure either engine fired.
//
// Nothing is summarised away — if an engine fired eleven times, eleven rows appear.
// One row per event, one line each: the engine's own recorded reason is the row's
// tooltip rather than a paragraph under it.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { monoXs, tabular } from '@/components/Builder/styles'
import type { SimEvent, SimRun } from '@/lib/position-sim'

import Stamp from './Stamp'
import { pct, usd, utcClock } from './format'

const KIND_COLOR: Record<SimEvent['kind'], string> = {
  liquidation: SEMANTIC_COLORS.danger,
  cure: SEMANTIC_COLORS.success,
  recall: SEMANTIC_COLORS.info,
  breach: SEMANTIC_COLORS.warning,
  frozen: SEMANTIC_COLORS.textSecondary,
}

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9px',
  letterSpacing: '0.24em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

const Cell: React.FC<{ children: React.ReactNode; color?: string }> = ({ children, color }) => (
  <Text
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="11px"
    {...tabular}
    color={color ?? SEMANTIC_COLORS.textPrimary}
    whiteSpace="nowrap"
  >
    {children}
  </Text>
)

const EventRows: React.FC<{ run: SimRun; title: string }> = ({ run, title }) => (
  <Box display="grid" gap={SPACING.sm} alignContent="start">
    <Box
      display="flex"
      justifyContent="space-between"
      alignItems="baseline"
      gap={SPACING.sm}
      flexWrap="wrap"
    >
      <Text {...HEAD}>{title}</Text>
      <Stamp provenance={run.provenance} />
    </Box>

    {run.events.length === 0 ? (
      <Text {...monoXs}>no events</Text>
    ) : (
      <Box display="grid" gap="1px">
        {run.events.map((e, k) => (
          <Box
            key={`${run.engine}-${e.minute}-${k}`}
            title={e.why}
            borderLeft="2px solid"
            borderLeftColor={KIND_COLOR[e.kind]}
            bg={SEMANTIC_COLORS.bgPrimary}
            px={SPACING.md}
            py="3px"
            display="flex"
            gap={SPACING.md}
            flexWrap="wrap"
            alignItems="baseline"
          >
            <Text {...HEAD} color={KIND_COLOR[e.kind]} minW="76px">
              {e.kind}
            </Text>
            <Cell color={SEMANTIC_COLORS.textSecondary}>{utcClock(e.ts)}</Cell>
            <Cell>repaid {usd(e.repaidUsd)}</Cell>
            <Cell>seized {usd(e.seizedUsd)}</Cell>
            <Cell>recalled {usd(e.recalledUsd)}</Cell>
            <Cell color={e.penaltyUsd > 0 ? SEMANTIC_COLORS.danger : undefined}>
              fee {usd(e.penaltyUsd)}
            </Cell>
            <Cell color={SEMANTIC_COLORS.textSecondary}>ltv {pct(e.ltv)}</Cell>
          </Box>
        ))}
      </Box>
    )}
  </Box>
)

export interface EventLogProps {
  source: SimRun
  membrane: SimRun
  sourceTitle: string
}

export const EventLog: React.FC<EventLogProps> = ({ source, membrane, sourceTitle }) => (
  <Box
    bg={SEMANTIC_COLORS.bgSecondary}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    p={SPACING.base}
    display="grid"
    gridTemplateColumns={{ base: '1fr', lg: '1fr 1fr' }}
    gap={SPACING.lg}
  >
    <EventRows run={source} title={sourceTitle} />
    <EventRows run={membrane} title="Membrane" />
  </Box>
)

export default EventLog
