import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { Card } from '@/components/ui/Card'
import { DemoAwareCta, MockStamp } from '@/components/demo'

import { useCanvasPainter } from './hooks/useCanvasPainter'
import { SectionHeading, Stamp } from './Primitives'
import { ctaGo } from './styles'
import { drawVault } from './utils'
import { ExecConfig } from './types'

export const VAULT_DEPOSIT_CONFIG: ExecConfig = {
  title: 'Deposit into Depth-Led Adaptive v2',
  rows: [
    { label: 'You deposit', value: '$5,000 CDT' },
    { label: 'Sim edge, epoch 4', value: '+3.86' },
    { label: 'Live vs sim, 12 weeks', value: '−0.9 drift — see chart' },
    { label: 'Fee', value: 'entry, decaying · shape OPEN' },
    { label: 'Withdraw', value: 'anytime, no lock' },
  ],
  note: 'Sim edge is not live edge. The chart beside this button is the honest version.',
  cta: 'Sign & deposit',
  done: 'Deposited',
}

const OpenChip: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Box
    as="span"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="8.5px"
    letterSpacing="0.18em"
    textTransform="uppercase"
    color={SEMANTIC_COLORS.warning}
    border="1px solid"
    borderColor={SEMANTIC_COLORS.warning}
    px="7px"
    py="2px"
  >
    {children}
  </Box>
)

const MRow: React.FC<{ label: React.ReactNode; value: React.ReactNode }> = ({ label, value }) => (
  <Box display="flex" justifyContent="space-between" gap={SPACING.sm} fontSize="10.5px">
    <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary}>
      {label}
    </Text>
    <Text as="span" fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textPrimary} textAlign="right">
      {value}
    </Text>
  </Box>
)

const VaultChart: React.FC = () => {
  const ref = useCanvasPainter((ctx, w, h) => drawVault(ctx, w, h), [])
  return (
    <Box
      position="relative"
      h="200px"
      bg={SEMANTIC_COLORS.bgPrimary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
    >
      <Box as="canvas" ref={ref} position="absolute" inset={0} w="100%" h="100%" />
    </Box>
  )
}

export interface MirrorVaultsProps {
  openExec: (config: ExecConfig) => void
}

export const MirrorVaults: React.FC<MirrorVaultsProps> = ({ openExec }) => (
  <>
    <SectionHeading
      index="05"
      title="Mirror vaults — two classes, one honest split"
      note="on-chain policy is copyable, so it cannot carry a fee · offchain compute can"
    />
    <Card
      display="grid"
      gridTemplateColumns={{ base: '1fr', md: 'minmax(0,1fr) minmax(0,1.3fr)' }}
      gap={SPACING.base}
      p={SPACING.base}
    >
      <Box>
        <Box display="flex" justifyContent="space-between" alignItems="baseline" gap={SPACING.sm}>
          <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="16px" color={SEMANTIC_COLORS.textPrimary}>
            Depth-Led Adaptive v2
          </Text>
          <OpenChip>frozen</OpenChip>
        </Box>

        <Box
          display="grid"
          gap="5px"
          mt={SPACING.md}
          pt={SPACING.md}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderSubtle}
        >
          <MRow label="Author" value="0x7a41…9c2e" />
          <MRow label={<>Sim edge, rank 1 of epoch 4 <MockStamp /></>} value="+3.86" />
          <MRow label="Deposits" value="$412k · 37 depositors" />
          <MRow label="Class" value="public policy — fully on-chain" />
          <MRow label="Fee" value="none — copyable code cannot charge rent" />
          <MRow label="Author earns" value="rank, provenance, and the listing it seeds" />
          <MRow label="Updates" value="none — frozen means the program, not the params" />
        </Box>

        <Box mt={SPACING.md} display="flex" gap={SPACING.sm} flexWrap="wrap">
          <DemoAwareCta {...ctaGo} onAction={() => openExec(VAULT_DEPOSIT_CONFIG)}>
            Deposit
          </DemoAwareCta>
        </Box>

        <Stamp>
          A frozen program still adapts — it was scored on reacting to regimes it had never seen.
          Fork it freely; that is the point of winning on-chain.
        </Stamp>

        <Box
          display="grid"
          gap="5px"
          mt={SPACING.md}
          pt={SPACING.md}
          borderTop="1px solid"
          borderColor={SEMANTIC_COLORS.borderStrong}
        >
          <Box display="flex" justifyContent="space-between" alignItems="center" gap={SPACING.sm}>
            <Text fontFamily={TYPOGRAPHY.fontDisplay} fontSize="13px" color={SEMANTIC_COLORS.textPrimary}>
              Operator vaults
            </Text>
            <OpenChip>offchain · fee-bearing</OpenChip>
          </Box>
          <MRow label="Why a fee holds" value="the model runs offchain — it costs money and cannot be read out" />
          <MRow label="Discipline" value="every update re-simulates before it activates" />
          <MRow label="Depositor view" value="same divergence chart, same rules" />
        </Box>
      </Box>

      <Box>
        <VaultChart />
        <Stamp>
          Live performance against the sim expectation band. The divergence is shown because it
          exists: sim edge is not live edge, and the drift between them is the honest number an
          allocator needs. Band = middle 80% of the 1,000 scored sims.
        </Stamp>
      </Box>
    </Card>
  </>
)

export default MirrorVaults
