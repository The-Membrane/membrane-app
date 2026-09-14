// THE SENIORITY LANDING.
//
// One argument, told in order: where a borrower sits in the loss waterfall, what that
// order buys them, why an incumbent will leave it alone, what the debt earns, and what
// the order did to 2,350 real liquidations.
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

import CarryFlagship from './CarryFlagship'
import CdtLine from './CdtLine'
import Close from './Close'
import Consequences from './Consequences'
import Hero from './Hero'
import Mimicry from './Mimicry'
import Waterfall from './Waterfall'

export const SeniorityLanding: React.FC<{ initialDoc?: EvidenceDoc | null }> = ({ initialDoc }) => (
  <Container maxW="1200px" py={SPACING.xl} px={SPACING_PATTERNS.pagePadding}>
    <VStack align="stretch" spacing={SPACING['2xl']}>
      <Hero />
      <Waterfall num="01" />
      <Consequences num="02" />
      <Mimicry num="03" />
      <CarryFlagship num="04" />
      <CdtLine num="05" />
      <Close num="06" initialDoc={initialDoc} />
    </VStack>
  </Container>
)

export default SeniorityLanding
