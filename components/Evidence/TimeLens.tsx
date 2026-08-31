import { Box, HStack, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import React from 'react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

import { Eyebrow, Stat } from './atoms'
import { pct } from './format'
import { TimeSummary } from './types'

/** One step of the funnel, drawn as a proportional bar. */
const Step: React.FC<{
  label: string
  n: number
  of: number
  color: string
  note: string
}> = ({ label, n, of, color, note }) => (
  <VStack align="stretch" spacing={SPACING.xs}>
    <HStack justify="space-between">
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        color={SEMANTIC_COLORS.textPrimary}
      >
        {label}
      </Text>
      <HStack spacing={SPACING.sm}>
        <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={color}>
          {n.toLocaleString()}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {pct(n / of)}
        </Text>
      </HStack>
    </HStack>
    <Box h="8px" w="100%" bg={SEMANTIC_COLORS.bgTertiary}>
      <Box h="100%" w={`${(n / of) * 100}%`} bg={color} />
    </Box>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.xs}
      color={SEMANTIC_COLORS.textTertiary}
    >
      {note}
    </Text>
  </VStack>
)

/**
 * What the 8-hour cure window would have done.
 *
 * The cure window is a REAL constant (28,800s, liquidation-engine/src/contract.rs:52).
 * Aave grants zero — its liquidation is atomic, emitted in the same block the
 * position goes unhealthy. So the question is simply: in the eight hours that
 * followed, did the price come back?
 *
 * This lens is PATH-DEPENDENT and says so. Oct 10 was a sharp wick with a partial
 * recovery. A window that keeps falling would not cure.
 */
export const TimeLens: React.FC<{ time: TimeSummary }> = ({ time }) => (
  <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
    <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING_PATTERNS.sectionGap}>
      <Stat
        label="Time Aave grants"
        value="0s"
        tone="bad"
        sub="liquidation is atomic, same block"
      />
      <Stat
        label="Time Membrane grants"
        value={`${time.membraneSecondsGranted / 3600}h`}
        tone="good"
        sub="cure window, before any sale"
      />
      <Stat
        label="Recovered in window"
        value={`${time.curedPct}%`}
        tone="good"
        sub={`median ${time.medianMinutesToCure} min`}
      />
      <Stat
        label="Still healthy at 8h"
        value={`${time.healthyAt8hPct}%`}
        tone="good"
        sub="the conservative claim"
      />
    </SimpleGrid>

    <Card variant="default">
      <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
        <Eyebrow>What the window would have caught</Eyebrow>
        <Step
          label="Accounts analysed"
          n={time.accountsAnalysed}
          of={time.accountsAnalysed}
          color={SEMANTIC_COLORS.textSecondary}
          note="ETH-like and BTC-like collateral — the assets the Oct 10 oracle series prices"
        />
        <Step
          label="Dropped back under their own line inside 8h"
          n={time.curedInWindow}
          of={time.accountsAnalysed}
          color={SEMANTIC_COLORS.info}
          note={`median ${time.medianMinutesToCure} minutes to recover — every one of these was sold anyway`}
        />
        <Step
          label="…and were still healthy at the 8-hour mark"
          n={time.healthyAt8h}
          of={time.accountsAnalysed}
          color={SEMANTIC_COLORS.success}
          note="these liquidations would not have happened at all"
        />
      </VStack>
    </Card>

    <Card variant="subtle">
      <VStack align="flex-start" spacing={SPACING.sm}>
        <Eyebrow color={SEMANTIC_COLORS.warning}>Read the gap between the last two bars</Eyebrow>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={SEMANTIC_COLORS.textSecondary}
          lineHeight="1.8"
        >
          {(time.curedInWindow - time.healthyAt8h).toLocaleString()} accounts recovered inside
          the window and then went back above their line before the eight hours were up. The
          cure window prevents the immediate forced sale — not every future one. Quote{' '}
          {time.healthyAt8hPct}% if you want the number that survives the obvious objection;
          quote {time.curedPct}% only with this sentence attached.
        </Text>
      </VStack>
    </Card>
  </VStack>
)
