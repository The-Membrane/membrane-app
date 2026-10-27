// THE HERO. The H1 and the line under it, nothing else.
//
// Every string here comes from facts.ts. The served variant (D, owner direction
// 2026-10-27) sells the borrower tool suite; the instrument panel (Toolkit.tsx) shows
// that suite directly under it, and the replay (Replay.tsx) follows. A, B and C stay
// reachable at ?v=a|b|c and render through the same layout.
//
// DEMO-FIRST (CLAUDE.md V20): there is no wallet gate anywhere in the hero.

import { VStack, Text } from '@chakra-ui/react'
import React from 'react'

import { Eyebrow } from '@/components/Evidence/atoms'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SUITE_VARIANT, type LandingVariant } from '@/lib/landingVariant'

import { HERO_VARIANTS } from './facts'

export interface HeroProps {
  /**
   * Chosen in getServerSideProps and rendered into the HTML, so the reader never sees one
   * headline swap for another. Defaults to the served suite variant.
   */
  variant?: LandingVariant
}

export const Hero: React.FC<HeroProps> = ({ variant = SUITE_VARIANT }) => {
  const HERO = HERO_VARIANTS[variant] ?? HERO_VARIANTS[SUITE_VARIANT]
  return (
    <VStack align="flex-start" spacing={SPACING.sm}>
      <Eyebrow>{HERO.eyebrow}</Eyebrow>
      <Text
        as="h1"
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h1}
        fontWeight={TYPOGRAPHY.bold}
        color={SEMANTIC_COLORS.textPrimary}
        lineHeight="1.15"
        maxW="820px"
        sx={{ textWrap: 'balance' }}
      >
        {HERO.headline}
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontDisplay}
        fontSize={TYPOGRAPHY.h4}
        fontStyle="italic"
        color={SEMANTIC_COLORS.textSecondary}
        maxW="720px"
        lineHeight="1.7"
      >
        {HERO.sub}
      </Text>
    </VStack>
  )
}

export default Hero
