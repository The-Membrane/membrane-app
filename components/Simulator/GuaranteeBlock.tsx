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

      {/* One line. No paragraph follows it — owner ruling 2026-09-11, "all these words
          are killing me". */}
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="13px"
        lineHeight={1.6}
        color={SEMANTIC_COLORS.textSecondary}
        maxW="72ch"
      >
        {GUARANTEE.noDials}
      </Text>
    </Box>
  </Box>
)

export default GuaranteeBlock
