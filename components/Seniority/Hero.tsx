// THE HERO. Two lines of copy, then the borrower simulator in hero form.
//
// Every string here comes from facts.ts. The simulator below is mounted with
// `hero`, which renders the verdict + the named guarantee and stops there — the
// rest of the sim lives at /[chain]/simulator.
//
// DEMO-FIRST (CLAUDE.md V20): there is no wallet gate. The simulator opens on the
// real Aave account it was seeded with, and connecting a wallet replaces it with
// the reader's own position (Simulator.tsx wallet prefill).

import { VStack, Text } from '@chakra-ui/react'
import React from 'react'

import { Eyebrow } from '@/components/Evidence/atoms'
import Simulator from '@/components/Simulator/Simulator'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { LandingVariant } from '@/lib/landingVariant'

import { HERO_VARIANTS } from './facts'

export interface HeroProps {
  /**
   * THE H1 TEST (owner ruling 2026-09-15). Chosen in getServerSideProps and rendered
   * into the HTML, so the reader never sees one headline swap for another. Defaults to
   * 'a', the saved original, for any caller outside the landing page.
   */
  variant?: LandingVariant
}

export const Hero: React.FC<HeroProps> = ({ variant = 'a' }) => {
  const HERO = HERO_VARIANTS[variant] ?? HERO_VARIANTS.a
  return (
    <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <VStack align="flex-start" spacing={SPACING.sm}>
        <Eyebrow>{HERO.eyebrow}</Eyebrow>
        <Text
          as="h1"
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize={TYPOGRAPHY.h1}
          fontWeight={TYPOGRAPHY.bold}
          color={SEMANTIC_COLORS.textPrimary}
          lineHeight="1.15"
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

      {/* THE BRIDGE: waterfall above, liquidation behaviour below. Mono, not a second
          serif dek, so it reads as the caption that hands one topic to the other. */}
      <VStack align="flex-start" spacing={SPACING.xs} maxW="720px">
        <Eyebrow>{HERO.bridge.eyebrow}</Eyebrow>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          color={SEMANTIC_COLORS.textPrimary}
          lineHeight="1.7"
          title={HERO.bridge.cite}
        >
          {HERO.bridge.line}
        </Text>
      </VStack>

      {/* The one conversion event of the test: an address run in this simulator,
          recorded with the variant that was rendered above it. */}
      <Simulator
        mode="borrower"
        hero
        connectLabel={HERO.cta}
        readNote={HERO.readNote}
        landingVariant={variant}
      />
    </VStack>
  )
}

export default Hero
