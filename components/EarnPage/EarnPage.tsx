import React from 'react'
import { Box, VStack } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { DemoBanner } from '@/components/demo'

import { Hero } from './Hero'
import { Composition } from './Composition'
import { ExitLiquidity } from './ExitLiquidity'
import { LossWaterfall } from './LossWaterfall'
import { RevenueFeed } from './RevenueFeed'
import { ShopWindow } from './ShopWindow'
import { SectionHeading } from './SectionHeading'
import { ExecutionSheet } from './ExecutionSheet'
import { ExecutionSheetProvider } from './hooks/useExecutionSheet'

/**
 * Earn — ported from public/proto/supply.html. Suppliers pick a seat (senior/junior tranche),
 * not a market; this page shows what backs that seat, what they can withdraw right now, where
 * losses land first, what fees they've earned, and what they could list next.
 */
export const EarnPage: React.FC = () => {
  return (
    <ExecutionSheetProvider>
      <Box maxW="1140px" mx="auto" px={SPACING.base} pb={SPACING['3xl']}>
        <DemoBanner note="wallet-scoped numbers are a demo wallet, not yours" />

        <VStack align="stretch" spacing={0} mt={SPACING.lg}>
          <Hero />

          <SectionHeading index="01" title="What is backing you" />
          <Composition />

          <SectionHeading index="02" title="Can you leave right now" />
          <ExitLiquidity />

          <SectionHeading index="03" title="Loss order" />
          <LossWaterfall />

          <SectionHeading index="04" title="Fees paid to you" />
          <RevenueFeed />

          <SectionHeading index="05" title="List a new collateral" />
          <ShopWindow />
        </VStack>

        <ExecutionSheet />
      </Box>
    </ExecutionSheetProvider>
  )
}

export default EarnPage
