import { Box, HStack, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import React from 'react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'

import { Eyebrow, Stat } from './atoms'
import { pct } from './format'
import { CureModel, TimeSummary } from './types'

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
 * What the 8-hour cure window did to the census, MODELLED, not diagnosed.
 *
 * The walk (lib/position-sim/curePath.ts) follows LiquidationEngine.sol: a breach
 * inside the band starts the delay; a return under the line clears it and a later
 * breach starts a fresh one; a move past line x (1 + band) sells at that minute; still
 * over the line at expiry sells at that minute. The census figure above is the SUM of
 * those sales. This lens shows how the 2,350 accounts resolved and what the delay was
 * worth against one immediate repay to cap.
 *
 * Path-dependent, and says so: Oct 10 was a sharp wick with a partial recovery.
 */
const OUTCOME_ROWS: { key: string; label: string; note: string; walked: boolean; tone: 'good' | 'bad' | 'dim' }[] = [
  { key: 'cured-then-held', label: 'Back under the line inside the window; never sold', note: 'the delay held and the day ended with the position intact', walked: true, tone: 'good' },
  { key: 'sold-at-expiry', label: 'Still over the line at 8h; sold then', note: 'repay to cap at that minute\u2019s price', walked: true, tone: 'bad' },
  { key: 'sold-at-band', label: 'Broke the band during the delay; sold at that minute', note: 'LTV passed line \u00d7 1.04 while the timer ran', walked: true, tone: 'bad' },
  { key: 'sold-at-grid-end', label: 'Price data ended mid-delay; sold at the last price', note: 'conservative: a sale is booked', walked: true, tone: 'bad' },
  { key: 'sold-at-t0', label: 'Already past the band when Aave hit; no delay exists', note: 'one repay to cap at t0, same as the one-repay figure', walked: true, tone: 'bad' },
  // 'sold-immediately-unlocated-line' used to live here. Those accounts are now
  // EXCLUDED from both sides of every total after the block-1 rebase (meta.excluded),
  // so they are not part of this histogram at all — showing them as a 0-row would
  // imply the walk resolved them. The exclusion and its Aave USD are in the caveats.

  { key: 'sold-immediately-no-series', label: 'Collateral has no Oct 10 price series', note: 'kept at one repay to cap; the window is never credited', walked: false, tone: 'dim' },
]

const usdM = (v: number) => `$${(v / 1e6).toFixed(1)}M`

export const TimeLens: React.FC<{ time: TimeSummary; cureModel: CureModel }> = ({ time, cureModel }) => {
  const total = Object.values(cureModel.outcomes).reduce((a, b) => a + b, 0)
  const walked = OUTCOME_ROWS.filter((r) => r.walked).reduce((a, r) => a + (cureModel.outcomes[r.key] ?? 0), 0)
  const held = cureModel.outcomes['cured-then-held'] ?? 0
  const colorOf = (t: 'good' | 'bad' | 'dim') =>
    t === 'good' ? SEMANTIC_COLORS.success : t === 'bad' ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textTertiary
  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <SimpleGrid columns={{ base: 2, md: 4 }} spacing={SPACING_PATTERNS.sectionGap}>
        <Stat label="Time Aave grants" value="0s" tone="bad" sub="liquidation is atomic, same block" />
        <Stat
          label="Time Membrane grants"
          value={`${cureModel.delaySeconds / 3600}h`}
          tone="good"
          sub={`inside a ${(cureModel.band * 100).toFixed(0)}% band over the line`}
        />
        <Stat
          label="Worth, against one repay"
          value={usdM(cureModel.delayCreditUsd)}
          tone="good"
          sub={`${usdM(cureModel.membraneOneRepayUsd)} one repay \u2192 ${usdM(cureModel.membraneOneRepayUsd - cureModel.delayCreditUsd)} with the delay`}
        />
        <Stat
          label="Held the whole day"
          value={held.toLocaleString()}
          tone="good"
          sub={`of ${walked.toLocaleString()} accounts the window could be walked for`}
        />
      </SimpleGrid>

      <Card variant="default">
        <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
          <Eyebrow>How every account resolved</Eyebrow>
          {OUTCOME_ROWS.map((r) => (
            <Step key={r.key} label={r.label} n={cureModel.outcomes[r.key] ?? 0} of={total} color={colorOf(r.tone)} note={r.note} />
          ))}
        </VStack>
      </Card>

      <Card variant="default">
        <VStack align="stretch" spacing={SPACING_PATTERNS.stackSpacing}>
          <Eyebrow>Where the credit comes from, and what the band does</Eyebrow>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.small} color={SEMANTIC_COLORS.textPrimary} lineHeight="1.7">
            {`${usdM(cureModel.cureCreditUsd)} of the credit is accounts that came back under their line. Of that, ${cureModel.cureCreditShareWithin2min.toFixed(0)}% recovered within two minutes of the breach, ${cureModel.cureCreditShareWithin1h.toFixed(0)}% within the hour, ${cureModel.cureCreditShareWithin8h.toFixed(0)}% inside the eight. Prices are the oracle round in force at each minute\u2019s start; a cure needs a fresh round, and ETH printed ${cureModel.freshEthPrints ?? 183} of ${cureModel.gridMinutes ?? 2880} minutes.`}
          </Text>
          <HStack spacing={SPACING_PATTERNS.sectionGap} flexWrap="wrap">
            {cureModel.bandSensitivity.map((b) => (
              <Stat
                key={b.band}
                label={`band ${(b.band * 100).toFixed(0)}%`}
                value={usdM(b.membraneClosedUsd)}
                tone={b.band === cureModel.band ? 'good' : 'muted'}
                sub={b.band === cureModel.band ? 'launch parameter, owner-set (Collateral.sol:223,232)' : 'sensitivity'}
              />
            ))}
          </HStack>
          <Text fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textTertiary} lineHeight="1.7">
            {`Diagnostic, older and looser: ${time.curedPct}% of the ${time.accountsAnalysed.toLocaleString()} priceable accounts dipped back under their line at some point in the eight hours (median ${time.medianMinutesToCure} min), and ${time.healthyAt8hPct}% were under it at the 8h mark. The model above is stricter: it sells on a band break and at expiry, and credits nothing to accounts whose line it cannot locate.`}
          </Text>
        </VStack>
      </Card>
    </VStack>
  )
}
