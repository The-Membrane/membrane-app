// THE NAMED GUARANTEE.
//
// A guarantee described as a mechanism is a guarantee unsold, so it is named here in
// four words and nothing else competes with it on the line.
//
// Every string on this surface comes from GUARANTEE (lib/position-sim/guarantee.ts),
// which is itself pinned to verified contract lines. This file writes NO claim of its
// own about the protocol — if the code changes, guarantee.ts changes, and this block
// changes with it. The limit ("the one thing that can shorten it") renders next to the
// claim and never collapses: a caveat behind a toggle stops being read.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow } from '@/components/Builder/styles'
import { GUARANTEE } from '@/lib/position-sim'

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

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
    gridTemplateColumns={{ base: '1fr', md: 'minmax(0, 260px) 1fr' }}
    gap={{ base: SPACING.base, md: SPACING.lg }}
    alignItems="start"
  >
    <Box display="grid" gap={SPACING.sm} alignContent="start">
      <Text {...eyebrow}>the guarantee</Text>
      <Text
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize="clamp(38px, 7vw, 68px)"
        lineHeight={1.02}
        letterSpacing="-0.02em"
        color={SEMANTIC_COLORS.success}
      >
        {GUARANTEE.name}
      </Text>
    </Box>

    <Box display="grid" gap={SPACING.md}>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="13px"
        lineHeight={1.8}
        color={SEMANTIC_COLORS.textPrimary}
        maxW="80ch"
      >
        {GUARANTEE.claim}
      </Text>

      <Box
        border="1px solid"
        borderColor={SEMANTIC_COLORS.warning}
        borderRadius={0}
        px={SPACING.md}
        py={SPACING.md}
        display="grid"
        gap={SPACING.xs}
      >
        <Text {...HEAD} color={SEMANTIC_COLORS.warning}>
          the one thing that can shorten it
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11.5px"
          lineHeight={1.75}
          color={SEMANTIC_COLORS.textPrimary}
          maxW="82ch"
        >
          {GUARANTEE.limit}
        </Text>
      </Box>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10px"
        letterSpacing="0.04em"
        lineHeight={1.7}
        color={SEMANTIC_COLORS.textTertiary}
        maxW="86ch"
      >
        {GUARANTEE.provenance}
      </Text>
    </Box>
  </Box>
)

export default GuaranteeBlock
