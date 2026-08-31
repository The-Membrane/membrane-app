import React, { useState } from 'react'
import { Box } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
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
      </Box>

      <ExecSheet config={execConfig} onClose={() => setExecConfig(null)} />
    </>
  )
}

export default Defend
