import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { DemoAwareCta } from '@/components/demo'

import { CopyChip, Eyebrow, Warm } from './Primitives'
import { ctaGhost, ctaGold } from './styles'
import { ExecConfig } from './types'

const bold = { fontWeight: 400 as const, color: SEMANTIC_COLORS.textPrimary }

export const DEPOSIT_TOP_CONFIG: ExecConfig = {
  title: 'Deposit into the rank-1 vault',
  rows: [
    { label: 'Vault', value: 'Depth-Led Adaptive v2 · rank 1' },
    { label: 'You deposit', value: '$5,000 CDT' },
    { label: 'Live vs sim, 12 weeks', value: '−0.9 drift' },
    { label: 'Withdraw', value: 'anytime' },
  ],
  note: 'Sim edge is not live edge. The vault section below shows the divergence chart.',
  cta: 'Sign & deposit',
  done: 'Deposited',
}

export const SUBMIT_CONFIG: ExecConfig = {
  title: 'Submit a strategy',
  rows: [
    { label: 'Runtime', value: 'WASM · sandboxed' },
    { label: 'Scored over', value: '1,000 randomized sims' },
    { label: 'Seed set', value: 'rotates per epoch' },
    { label: 'Cooldown', value: 'applies after submit' },
  ],
  note: 'Scored on hidden regimes your program cannot see. This will not predict your rank.',
  cta: 'Sign & submit',
  done: 'Submitted',
}

const Belt: React.FC<{ on?: boolean; children: React.ReactNode }> = ({ on, children }) => (
  <Box
    as="span"
    border="1px solid"
    borderColor={on ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.borderSubtle}
    color={on ? SEMANTIC_COLORS.warning : SEMANTIC_COLORS.textTertiary}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="10px"
    letterSpacing="0.16em"
    textTransform="uppercase"
    px={SPACING.md}
    py="5px"
  >
    {children}
  </Box>
)

export interface HeroProps {
  openExec: (config: ExecConfig) => void
}

export const Hero: React.FC<HeroProps> = ({ openExec }) => (
  <Box>
    <Eyebrow>Defend</Eyebrow>
    <Text
      as="h1"
      mt={SPACING.sm}
      fontFamily={TYPOGRAPHY.fontDisplay}
      fontSize={TYPOGRAPHY.h1}
      color={SEMANTIC_COLORS.textPrimary}
      letterSpacing="-0.01em"
    >
      Design a better risk curator.
    </Text>

    <Warm mt={SPACING.sm}>
      Submit a program. Each step it reads market state — reserves, oracle price, utilization,
      clearable depth, flow, position distribution — and outputs the{' '}
      <Text as="b" {...bold}>
        whole risk vector
      </Text>
      : liquidation LTV, borrow gap, collateral caps, delay length, oracle tolerance. We score it
      over{' '}
      <Text as="b" {...bold}>
        1,000 randomized simulations
      </Text>{' '}
      against hidden regimes it cannot see, and rank it by average edge. Win on-chain and your policy
      becomes protocol infrastructure — public, forkable, your name on it. Run a private model
      offchain and{' '}
      <Text as="b" {...bold}>
        charge for it
      </Text>
      : compute costs are the only real fee moat, because anything fully on-chain can be copied the
      day it wins. The house entries below are real venue policies; the challenge is beating
      Membrane’s own algorithm.
    </Warm>

    <Box mt={SPACING.md} display="flex" gap={SPACING.sm} flexWrap="wrap" alignItems="center">
      <DemoAwareCta {...ctaGold} onAction={() => openExec(SUBMIT_CONFIG)}>
        Submit a strategy
      </DemoAwareCta>
      <DemoAwareCta {...ctaGhost} onAction={() => openExec(DEPOSIT_TOP_CONFIG)}>
        Deposit into the top strategy
      </DemoAwareCta>
      <CopyChip value="github.com/membrane-fi/curator-starter" fontSize="10px">
        starter repo ⧉
      </CopyChip>
    </Box>

    <Box mt={SPACING.base} display="flex" gap={SPACING.sm} alignItems="center" flexWrap="wrap">
      <Belt>read a curator</Belt>
      <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
        →
      </Text>
      <Belt>allocate across curators</Belt>
      <Text as="span" color={SEMANTIC_COLORS.textTertiary}>
        →
      </Text>
      <Belt on>become one</Belt>
    </Box>
  </Box>
)

export default Hero
