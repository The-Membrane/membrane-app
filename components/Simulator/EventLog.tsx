// The receipt: every liquidation, recall and cure either engine fired, with the reason
// the engine itself recorded. Nothing is summarised away — if an engine fired eleven
// times, eleven rows appear.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow, monoXs, tabular } from '@/components/Builder/styles'
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
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

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
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11.5px"
        color={SEMANTIC_COLORS.textSecondary}
      >
        No event fired. The position never crossed its line over this window.
      </Text>
    ) : (
      <Box display="grid" gap={SPACING.sm}>
        {run.events.map((e, k) => (
          <Box
            key={`${run.engine}-${e.minute}-${k}`}
            border="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            borderLeft="2px solid"
            borderLeftColor={KIND_COLOR[e.kind]}
            bg={SEMANTIC_COLORS.bgPrimary}
            px={SPACING.md}
            py={SPACING.sm}
            display="grid"
            gap={SPACING.xs}
          >
            <Box display="flex" gap={SPACING.md} flexWrap="wrap" alignItems="baseline">
              <Text {...HEAD} color={KIND_COLOR[e.kind]}>
                {e.kind}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                color={SEMANTIC_COLORS.textSecondary}
                {...tabular}
              >
                {utcClock(e.ts)} · minute {e.minute.toLocaleString('en-US')}
              </Text>
            </Box>
            <Box display="flex" gap={SPACING.md} flexWrap="wrap">
              {[
                ['repaid', usd(e.repaidUsd)],
                ['seized', usd(e.seizedUsd)],
                ['recalled', usd(e.recalledUsd)],
                ['penalty', usd(e.penaltyUsd)],
                ['ltv after', pct(e.ltv)],
                ['line', pct(e.line)],
              ].map(([label, value]) => (
                <Box key={label} display="grid" gap="1px">
                  <Text {...monoXs}>{label}</Text>
                  <Text
                    fontFamily={TYPOGRAPHY.fontMono}
                    fontSize="12px"
                    {...tabular}
                    color={
                      label === 'penalty' && e.penaltyUsd > 0
                        ? SEMANTIC_COLORS.danger
                        : SEMANTIC_COLORS.textPrimary
                    }
                  >
                    {value}
                  </Text>
                </Box>
              ))}
            </Box>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11px"
              color={SEMANTIC_COLORS.textSecondary}
              lineHeight={1.7}
              maxW="72ch"
            >
              {e.why}
            </Text>
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
    gap={SPACING.base}
  >
    <Text {...eyebrow}>05 / the receipt</Text>
    <Box display="grid" gridTemplateColumns={{ base: '1fr', lg: '1fr 1fr' }} gap={SPACING.lg}>
      <EventRows run={source} title={sourceTitle} />
      <EventRows run={membrane} title="Membrane" />
    </Box>
  </Box>
)

export default EventLog
