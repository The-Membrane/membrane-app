// CARRY — the flagship, below the fold.
//
// The four claim lines are CARRY_CLAIMS verbatim (lib/position-sim/guarantee.ts, owner
// wording 2026-09-12), reached through facts.ts. They are not restated here.

import { Button, Text, VStack } from '@chakra-ui/react'
import NextLink from 'next/link'
import React from 'react'

import { Eyebrow } from '@/components/Evidence/atoms'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, HOVER_EFFECTS, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'

import { Cite } from './BondCoverage'
import { CARRY } from './facts'

export const CarryFlagship: React.FC<{ num?: string }> = ({ num = '04' }) => {
  const { chainName } = useChainRoute()

  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <Eyebrow>
        {num} / {CARRY.eyebrow}
      </Eyebrow>

      <VStack align="flex-start" spacing={SPACING.sm}>
        <Text
          as="h2"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h2}
          fontWeight={TYPOGRAPHY.semibold}
          color={SEMANTIC_COLORS.textPrimary}
          maxW="820px"
          lineHeight="1.25"
        >
          {CARRY.headline}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h4}
          fontStyle="italic"
          color={SEMANTIC_COLORS.textSecondary}
          maxW="760px"
          lineHeight="1.7"
        >
          {CARRY.sub}
        </Text>
      </VStack>

      {/* Four lines, hairline-separated. One claim per row, countable at a glance. */}
      <VStack
        align="stretch"
        spacing={SPACING.none}
        borderTop="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
      >
        {CARRY.claims.map((c) => (
          <Text
            key={c}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textPrimary}
            lineHeight="1.8"
            py={SPACING_PATTERNS.cardPadding}
            borderBottom="1px solid"
            borderColor={SEMANTIC_COLORS.borderSubtle}
            maxW="80ch"
          >
            {c}
          </Text>
        ))}
      </VStack>

      <Cite>{CARRY.cite}</Cite>

      <Button
        as={NextLink}
        href={`/${chainName}${CARRY.href}`}
        variant="ghost"
        alignSelf="flex-start"
        borderRadius={0}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        transition={TRANSITIONS.colors}
        _hover={HOVER_EFFECTS.borderHighlight}
        _active={ACTIVE_EFFECTS.dim}
        _focus={FOCUS_STYLES.ring}
      >
        Open the carry page
      </Button>
    </VStack>
  )
}

export default CarryFlagship
