// THE NAMED GUARANTEE.
//
// A guarantee described as a mechanism is a guarantee unsold, so it is named here in
// one number and nothing else competes with it on the line.
//
// Every string on this surface comes from GUARANTEE (lib/position-sim/guarantee.ts),
// which is itself pinned to verified contract lines. This file writes NO claim of its
// own about the protocol — if the code changes, guarantee.ts changes, and this block
// changes with it. The limit renders next to the claim and never collapses: a caveat
// behind a toggle stops being read. GUARANTEE.provenance moves to the fine print.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { GUARANTEE } from '@/lib/position-sim'
import { OCT10_SCALE_LINE } from '@/lib/position-sim/oct10Totals'
import { stamp as stampFn } from '@/lib/position-sim/types'
import Stamp from './Stamp'

const GUARANTEE_PROV = stampFn('dataset', 'rule in code', GUARANTEE.provenance)

export const GuaranteeBlock: React.FC = () => (
  <Box
    data-testid="sim-guarantee"
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    bg={SEMANTIC_COLORS.bgPrimary}
    borderRadius={0}
    px={{ base: SPACING.base, md: SPACING.lg }}
    py={{ base: SPACING.base, md: SPACING.lg }}
    display="grid"
    gridTemplateColumns={{ base: '1fr', md: 'minmax(0, auto) 1fr' }}
    gap={{ base: SPACING.md, md: SPACING.lg }}
    alignItems="center"
  >
    <Text
      fontFamily={TYPOGRAPHY.fontDisplay}
      fontSize="clamp(64px, 10vw, 120px)"
      lineHeight={0.95}
      letterSpacing="-0.03em"
      color={SEMANTIC_COLORS.success}
    >
      {GUARANTEE.name}
    </Text>

    <Box display="grid" gap={SPACING.md}>
      {/* THE SCALE LINE (owner 2026-09-22): the number that makes 4% not small. Measured,
          from OCT10_TOTALS; the figure and window swap when the multi-year scan lands. */}
      <Text
        data-testid="sim-scale-line"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize="clamp(20px, 2.6vw, 26px)"
        lineHeight={1.25}
        color={SEMANTIC_COLORS.textPrimary}
        maxW="30ch"
      >
        4% sounds small.{' '}
        <Text as="span" color={SEMANTIC_COLORS.success}>
          It would have kept {OCT10_SCALE_LINE.figure} of collateral
        </Text>{' '}
        {OCT10_SCALE_LINE.window}.
      </Text>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="16px"
        lineHeight={1.6}
        color={SEMANTIC_COLORS.textPrimary}
        maxW="70ch"
      >
        {GUARANTEE.claim}
      </Text>

      <Text
        borderLeft="2px solid"
        borderColor={SEMANTIC_COLORS.warning}
        pl={SPACING.md}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="13px"
        lineHeight={1.6}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="72ch"
      >
        {GUARANTEE.limit}
      </Text>
      <Stamp provenance={GUARANTEE_PROV} />

      {/* One line. No paragraph follows it — owner ruling 2026-09-11, "all these words
          are killing me". */}
      {/* <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="13px"
        lineHeight={1.6}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="72ch"
      >
        {GUARANTEE.noDials}
      </Text> */}
    </Box>
  </Box>
)

export default GuaranteeBlock
