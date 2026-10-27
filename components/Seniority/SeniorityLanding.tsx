// THE LANDING: the borrower's instrument panel, then the seniority argument.
//
// Owner direction 2026-10-27 (board Q26-S1): sell the whole borrower tool suite, not only
// the liquidation delay. So the page opens on the suite (hero + Toolkit), lets the reader
// run the replay on their own position, and then tells the seniority argument in order:
// where a borrower sits in the loss waterfall, what that order buys them, why an
// incumbent will leave it alone, what the debt earns, and what the order did to 2,350
// real liquidations.
//
// Every factual sentence on this surface comes from components/Seniority/facts.ts,
// which carries a contract citation for each one. Nothing is written here.
//
// DEMO-FIRST (CLAUDE.md V20): the whole page renders with no wallet. The hero opens on
// a real liquidated Aave account; connecting a wallet swaps that for the reader's own
// position through the simulator's prefill, and every other band is protocol-scoped.

import { Container, VStack } from '@chakra-ui/react'
import React from 'react'

import type { EvidenceDoc } from '@/components/Evidence/types'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import type { LandingVariant } from '@/lib/landingVariant'

import CarryFlagship from './CarryFlagship'
import CdtLine from './CdtLine'
import Close from './Close'
import Consequences from './Consequences'
import Hero from './Hero'
import Mimicry from './Mimicry'
import Replay from './Replay'
import Toolkit from './Toolkit'
import Waterfall from './Waterfall'

export interface SeniorityLandingProps {
  initialDoc?: EvidenceDoc | null
  /**
   * THE H1 TEST (owner ruling 2026-09-15). Resolved in the page's getServerSideProps
   * and passed straight through to the hero, so the headline is in the first HTML byte.
   */
  variant?: LandingVariant
}

export const SeniorityLanding: React.FC<SeniorityLandingProps> = ({ initialDoc, variant }) => (
  <Container maxW="1200px" py={SPACING.xl} px={SPACING_PATTERNS.pagePadding}>
    <VStack align="stretch" spacing={SPACING['2xl']}>
      <Hero variant={variant} />
      <Toolkit num="01" />
      <Replay num="02" variant={variant} />
      <Waterfall num="03" />
      <Consequences num="04" />
      <Mimicry num="05" />
      <CarryFlagship num="06" />
      <CdtLine num="07" />
      <Close num="08" initialDoc={initialDoc} />
    </VStack>
  </Container>
)

export default SeniorityLanding
