import React, { useState } from 'react'
import NextLink from 'next/link'
import { Box, Grid, HStack, Text } from '@chakra-ui/react'

import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { MockStamp } from '@/components/demo'

import { Eyebrow } from './primitives'
import { ExecButton } from './ExecContext'
import { POINTS_CLASSES } from './fixtures'
import { money } from './utils'
import { PointsClass } from './types'

/**
 * Points & sacrifice portfolio editor (ported from the `ptrows` script in
 * public/proto/dash.html). Continuous r, no tiers, no cranks: sacrifice boosts
 * land the instant revenue arrives, pending points flush at the next touch.
 * Contract shape: PointsSystem.setSacrifice(Class, rWad); claim(epoch, class).
 */

const ClassRow: React.FC<{ k: PointsClass }> = ({ k }) => {
  const { chainName } = useChainRoute()
  const [r, setR] = useState(k.r)

  if (!k.active) {
    return (
      <Grid gridTemplateColumns={{ base: '1fr', md: '120px 1fr' }} gap={SPACING.base} alignItems="center" py="10px" borderBottom="1px solid" borderColor={SEMANTIC_COLORS.borderSubtle} _last={{ borderBottom: 'none' }} fontSize="11px">
        <Box fontFamily={TYPOGRAPHY.fontMono} fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textPrimary}>
          {k.c}
          <Text as="span" display="block" fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.14em" textTransform="uppercase">
            {k.sub}
          </Text>
        </Box>
        <Text fontFamily={TYPOGRAPHY.fontMono} color={SEMANTIC_COLORS.textSecondary} lineHeight={1.6}>
          no weight this epoch — run a policy on{' '}
          <NextLink href={`/${chainName}/defend`} passHref legacyBehavior>
            <Box as="a" color={SEMANTIC_COLORS.success} transition={TRANSITIONS.colors} _hover={{ textDecoration: 'underline' }}>
              Defend
            </Box>
          </NextLink>{' '}
          to earn here
        </Text>
      </Grid>
    )
  }

  const outOfSync = k.synced !== r

  return (
    <Grid
      gridTemplateColumns={{ base: '1fr', md: '120px 1.25fr 1.35fr auto' }}
      gap={SPACING.base}
      alignItems="center"
      py="10px"
      borderBottom="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      _last={{ borderBottom: 'none' }}
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="11px"
    >
      <Box fontSize={TYPOGRAPHY.xs} color={SEMANTIC_COLORS.textPrimary}>
        {k.c}
        <Text as="span" display="block" fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.14em" textTransform="uppercase">
          {k.sub}
        </Text>
      </Box>

      <Box color={SEMANTIC_COLORS.textSecondary} lineHeight={1.6}>
        this epoch{' '}
        <Box as="span" color={SEMANTIC_COLORS.textPrimary}>
          ~{k.pend.toFixed(1)} MBRN
        </Box>{' '}
        est · epoch 2 final{' '}
        <Box as="span" color={SEMANTIC_COLORS.textPrimary}>
          {k.closed.toFixed(1)} MBRN
        </Box>
        <ExecButton
          ml={SPACING.sm}
          payload={{
            title: `Claim epoch 2 — ${k.c}`,
            rows: [
              ['Epoch', '2 · closed · final'],
              ['MBRN minted to you', k.closed.toFixed(1)],
            ],
            note: 'Closed-epoch rewards are final. Open-epoch estimates keep moving until the epoch closes.',
            cta: 'Sign & claim',
            done: 'MBRN in wallet',
          }}
        >
          Claim
        </ExecButton>
      </Box>

      <Box display="grid" gap="3px">
        <Text fontSize="9.5px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.5}>
          r=
          <Box as="span" color={SEMANTIC_COLORS.textPrimary}>
            {r}%
          </Box>{' '}
          · keep {money(k.fee * (1 - r / 100))} of {money(k.fee)}/mo · points{' '}
          <Box as="span" color={SEMANTIC_COLORS.textPrimary}>
            {(1 + r / 100).toFixed(2)}×
          </Box>
          {outOfSync && (
            <Box as="span" display="block" color={SEMANTIC_COLORS.warning}>
              Transmuter synced at {k.synced}% — the new {r}% applies at your next deposit or exit there
            </Box>
          )}
        </Text>
        <Box
          as="input"
          type="range"
          min={0}
          max={100}
          step={5}
          value={r}
          aria-label={`Sacrifice ratio for ${k.c}`}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setR(Number(e.target.value))}
          w="100%"
          h="14px"
          cursor="pointer"
          sx={{
            appearance: 'none',
            bg: 'transparent',
            '&::-webkit-slider-runnable-track': { height: '2px', bg: SEMANTIC_COLORS.borderStrong },
            '&::-webkit-slider-thumb': {
              appearance: 'none',
              width: '10px',
              height: '10px',
              bg: SEMANTIC_COLORS.success,
              marginTop: '-4px',
              border: 0,
            },
            '&::-moz-range-track': { height: '2px', bg: SEMANTIC_COLORS.borderStrong },
            '&::-moz-range-thumb': { width: '10px', height: '10px', bg: SEMANTIC_COLORS.success, border: 0, borderRadius: 0 },
          }}
        />
      </Box>

      <ExecButton
        payload={{
          title: `Set sacrifice — ${k.c}`,
          rows: [
            ['Class', k.c],
            ['New ratio r', `${r}%`],
            ['Fees you keep', `${100 - r}% — ${money(k.fee * (1 - r / 100))} of ${money(k.fee)}/mo`],
            ['Points weight', `${(1 + r / 100).toFixed(2)}× fee-value`],
            ['Where forgone fees go', 'your own pool — tranche rate / revenue share'],
          ],
          note:
            'One transaction to PointsSystem. Immediate and reversible. The Transmuter syncs at your next touch there — until then its cached ratio keeps applying.',
          cta: 'Sign & set',
          done: 'Sacrifice set',
        }}
      >
        Set
      </ExecButton>
    </Grid>
  )
}

export const PointsCard: React.FC = () => (
  <Card mt={SPACING.base} id="ptcard">
    <HStack justify="space-between" align="baseline" spacing={SPACING.md} flexWrap="wrap">
      <Eyebrow>
        Points · epoch 3, open <MockStamp />
      </Eyebrow>
      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.12em">
        100,000 MBRN / month · 33,333 per class · closes in 12d 06h
      </Text>
    </HStack>
    <Box mt={SPACING.sm}>
      {POINTS_CLASSES.map((k) => (
        <ClassRow key={k.c} k={k} />
      ))}
    </Box>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="9px" color={SEMANTIC_COLORS.textTertiary} letterSpacing="0.12em" mt={SPACING.sm} lineHeight={1.6}>
      open-epoch numbers are estimates — they shrink as others accrue weight; closed epochs are final and
      claimable · there is no crank anywhere: sacrifice boosts land the instant revenue arrives, and your
      pending points flush at your next touch · forgone fees boost your own pool, not the protocol’s
    </Text>
  </Card>
)
