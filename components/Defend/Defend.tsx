import React, { useState } from 'react'
import { Box, HStack, Text } from '@chakra-ui/react'
import NextLink from 'next/link'

import { SPACING } from '@/config/spacing'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { DemoBanner } from '@/components/demo'

import { DecisionSurface } from './DecisionSurface'
import { DecisionsPending } from './DecisionsPending'
import { ExecSheet } from './ExecSheet'
import { Hero } from './Hero'
import { Leaderboard } from './Leaderboard'
import { MirrorVaults } from './MirrorVaults'
import { RegimeBleed } from './RegimeBleed'
import { Sandbox } from './Sandbox'
import { SimCannotSee } from './SimCannotSee'
import { Submit } from './Submit'
import { ExecConfig } from './types'

/**
 * Defend — curator design surface (ported from public/proto/defend.html).
 * Wallet-scoped: opens fully populated from fixtures under a DemoBanner; every
 * transact CTA routes through DemoAwareCta + the ExecSheet confirm choreography.
 */
export const Defend: React.FC = () => {
  const [execConfig, setExecConfig] = useState<ExecConfig | null>(null)
  const { chainName } = useChainRoute()

  return (
    <>
      <DemoBanner note="wallet-scoped numbers are a demo wallet · live market data stays live" />

      <Box maxW="1140px" mx="auto" px={SPACING.base} py={SPACING.lg}>
        <Hero openExec={setExecConfig} />
        <DecisionSurface />
        <Leaderboard />
        <RegimeBleed />
        <Sandbox />
        <MirrorVaults openExec={setExecConfig} />
        <SimCannotSee />
        <Submit openExec={setExecConfig} />
        <DecisionsPending />

        <HStack spacing={SPACING.lg} flexWrap="wrap" mt={SPACING.lg}>
          <NextLink href={`/${chainName}/carry`} style={{ textDecoration: 'underline' }}>
            <Text as="span" fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} _hover={{ color: SEMANTIC_COLORS.success }}>
              the carry board → /carry
            </Text>
          </NextLink>
        </HStack>
      </Box>

      <ExecSheet config={execConfig} onClose={() => setExecConfig(null)} />
    </>
  )
}

export default Defend
