// The secondary simulation: what the borrowed capital was actually doing.
//
// THE RULE HERE IS STRICT (lib/position-sim/venues.ts): if a deployment cannot be
// DETECTED, this section does not exist. No inferred deployment, no illustrative one,
// no "a typical borrower would have…". A failed or empty scan gets one quiet line
// saying exactly that, and nothing else.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow, monoXs, tabular } from '@/components/Builder/styles'
import type { VenueDetection } from '@/lib/position-sim'

import Stamp from './Stamp'
import { amt, pct, usd } from './format'

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

export interface DeploymentSectionProps {
  /** null when no address has been read — there is nothing to have scanned. */
  detection: VenueDetection | null
  /** The recall/fast rates actually in force, which the user may have edited. */
  recallRate: number
  fastRate: number
}

export const DeploymentSection: React.FC<DeploymentSectionProps> = ({
  detection,
  recallRate,
  fastRate,
}) => {
  if (!detection) return null

  if (detection.status !== 'detected') {
    return (
      <Text {...monoXs} lineHeight={1.7} maxW="86ch">
        {detection.message ??
          'No deployment was detected for this address across the venues we check.'}
      </Text>
    )
  }

  return (
    <Box
      bg={SEMANTIC_COLORS.bgSecondary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p={SPACING.base}
      display="grid"
      gap={SPACING.md}
    >
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="baseline"
        gap={SPACING.md}
        flexWrap="wrap"
      >
        <Text {...eyebrow}>06 / where the capital sits</Text>
        <Stamp provenance={detection.provenance} />
      </Box>

      <Box display="flex" gap={SPACING.lg} flexWrap="wrap" alignItems="baseline">
        <Box display="grid" gap="2px">
          <Text {...HEAD}>detected on-chain</Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="clamp(18px, 2.6vw, 24px)"
            {...tabular}
            color={SEMANTIC_COLORS.info}
          >
            {usd(detection.totalUsd)}
          </Text>
        </Box>
        <Box display="grid" gap="2px">
          <Text {...HEAD}>recall / fast in force</Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="clamp(18px, 2.6vw, 24px)"
            {...tabular}
            color={SEMANTIC_COLORS.warning}
          >
            {pct(recallRate)} / {pct(fastRate)}
          </Text>
        </Box>
      </Box>

      <Box overflowX="auto">
        <Box as="table" w="100%" minW="560px" style={{ borderCollapse: 'collapse' }}>
          <Box as="thead">
            <Box as="tr">
              {[
                'venue',
                'balance',
                'value',
                'default recall',
                'default fast',
                'how the exit works',
              ].map((h, i) => (
                <Box
                  as="th"
                  key={h}
                  {...HEAD}
                  fontWeight={TYPOGRAPHY.normal}
                  textAlign={i === 0 || i === 5 ? 'left' : 'right'}
                  py={SPACING.xs}
                  pr={SPACING.md}
                  borderBottom="1px solid"
                  borderColor={SEMANTIC_COLORS.borderSubtle}
                >
                  {h}
                </Box>
              ))}
            </Box>
          </Box>
          <Box as="tbody">
            {detection.detected.map((d) => (
              <Box as="tr" key={d.venue.address}>
                <Box
                  as="td"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11.5px"
                  color={SEMANTIC_COLORS.textPrimary}
                  py={SPACING.xs}
                  pr={SPACING.md}
                >
                  {d.venue.symbol}
                </Box>
                <Box
                  as="td"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11.5px"
                  {...tabular}
                  color={SEMANTIC_COLORS.textPrimary}
                  textAlign="right"
                  py={SPACING.xs}
                  pr={SPACING.md}
                >
                  {amt(d.amount)}
                </Box>
                <Box
                  as="td"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11.5px"
                  {...tabular}
                  color={SEMANTIC_COLORS.textPrimary}
                  textAlign="right"
                  py={SPACING.xs}
                  pr={SPACING.md}
                >
                  {usd(d.valueUsd)}
                </Box>
                <Box
                  as="td"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11.5px"
                  {...tabular}
                  color={SEMANTIC_COLORS.warning}
                  textAlign="right"
                  py={SPACING.xs}
                  pr={SPACING.md}
                >
                  {pct(d.venue.recallRate, 0)}
                </Box>
                <Box
                  as="td"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11.5px"
                  {...tabular}
                  color={SEMANTIC_COLORS.warning}
                  textAlign="right"
                  py={SPACING.xs}
                  pr={SPACING.md}
                >
                  {pct(d.venue.fastRate, 0)}
                </Box>
                <Box
                  as="td"
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize="11px"
                  color={SEMANTIC_COLORS.textSecondary}
                  py={SPACING.xs}
                  lineHeight={1.6}
                >
                  {d.venue.exit}
                </Box>
              </Box>
            ))}
          </Box>
        </Box>
      </Box>

      <Text {...monoXs} lineHeight={1.75} maxW="86ch">
        Balances are read on-chain and valued at $1 per unit, which understates any of these tokens
        trading above par. The two rate columns are gold because they are modelled, not measured:
        they are our reading of each venue&apos;s own exit mechanics, and the weighted result of
        them is what the recall and fast sliders start at. A venue that redeems on demand in a quiet
        market is not the same venue during a forty-minute crash. This scan checks a fixed list of
        yield tokens — a balance of zero across that list is not proof there is no deployment.
      </Text>
    </Box>
  )
}

export default DeploymentSection
