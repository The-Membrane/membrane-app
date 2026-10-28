// THE REPLAY. The bridge line, then the borrower simulator in hero form.
//
// Moved out of the hero (owner direction 2026-10-27): the hero now sells the whole
// borrower suite, and the replay is the one tool on the page a stranger can run on their
// own position right now, so it carries the page's single primary action.
//
// The simulator is mounted with `hero`, which renders the verdict + the named guarantee
// and stops there; the rest of the sim lives at /[chain]/simulator. It opens on the real
// Aave account it was seeded with, and connecting a wallet replaces it with the reader's
// own position (Simulator.tsx wallet prefill). No wallet gate.

import { VStack, Text } from '@chakra-ui/react'
import React from 'react'

import { Eyebrow } from '@/components/Evidence/atoms'
import Simulator from '@/components/Simulator/Simulator'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { SUITE_VARIANT, type LandingVariant } from '@/lib/landingVariant'

import { HERO_VARIANTS } from './facts'

export const Replay: React.FC<{ num?: string; variant?: LandingVariant }> = ({
  num = '02',
  variant = SUITE_VARIANT,
}) => {
  const HERO = HERO_VARIANTS[variant] ?? HERO_VARIANTS[SUITE_VARIANT]
  return (
    <VStack as="section" align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
      <VStack align="flex-start" spacing={SPACING.xs} maxW="720px">
        <Eyebrow>
          {num} / {HERO.bridge.eyebrow}
        </Eyebrow>
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

      {/* The one conversion event: an address run in this simulator, recorded with the
          variant that was rendered above it. */}
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

export default Replay
