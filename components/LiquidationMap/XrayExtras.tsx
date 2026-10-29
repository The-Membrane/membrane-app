import React, { useMemo, useState } from 'react'
import { Box, HStack, Input, SimpleGrid, Text, VStack } from '@chakra-ui/react'

import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow, Stat } from '@/components/Evidence/atoms'

import { applyWhatIf, type Breaches } from './marketsLogic'
import type { XrayReserve } from './xrayLogic'

// X-ray add-ons: crash history (price risk), carry at today's rates (ratio loops)
// and a what-if simulator. History and carry are measured inputs; the what-if is
// deterministic arithmetic on the position read. None of it is a forecast.

const pct = (v: number | null, dp = 1) => (v === null ? '—' : `${(v * 100).toFixed(dp)}%`)

export const CrashHistory: React.FC<{
  history: (Breaches & { source: string }) | null
  distance: number | null
}> = ({ history, distance }) => {
  if (!history || distance === null) return null
  const w = ['1d', '7d', '30d'].filter((k) => history[k])
  return (
    <VStack align="stretch" spacing={SPACING.sm}>
      <Eyebrow>Past moves that would have crossed {pct(distance)}</Eyebrow>
      <SimpleGrid columns={{ base: 1, md: 3 }} spacing={SPACING.base}>
        {w.map((k) => (
          <Stat
            key={k}
            label={`Within ${k.replace('d', ' day')}${k === '1d' ? '' : 's'}`}
            value={`${history[k].breaches.toLocaleString('en-US')} of ${history[k].windows.toLocaleString('en-US')}`}
            sub={`worst: ${history[k].worst.map((x) => `${pct(x.drop, 0)} (${x.start})`).join(', ')}`}
            tone="muted"
          />
        ))}
      </SimpleGrid>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
      >
        Every day starts one window, so windows overlap. A count of history, not a probability ·{' '}
        {history.source}
      </Text>
    </VStack>
  )
}

export const CarryAtRates: React.FC<{
  carry: { carryGapPerYear: number | null; daysToHf1: number | null } | null
}> = ({ carry }) => {
  if (!carry || carry.carryGapPerYear === null) return null
  const rising = carry.carryGapPerYear <= 0
  return (
    <VStack align="stretch" spacing={SPACING.xs}>
      <Eyebrow>Carry at today&apos;s rates</Eyebrow>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.small}
        color={rising ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning}
      >
        {rising
          ? `Health rises ${pct(-carry.carryGapPerYear, 2)} a year: the yield beats the borrow rate.`
          : `Health falls ${pct(carry.carryGapPerYear, 2)} a year${
              carry.daysToHf1 !== null
                ? `: liquidation in about ${Math.round(carry.daysToHf1)} days if rates held`
                : ''
            }.`}
      </Text>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
      >
        Yield = 30-day growth of the collateral&apos;s oracle ratio to WETH. Rates held constant:
        arithmetic, not a forecast.
      </Text>
    </VStack>
  )
}

const Field: React.FC<{
  label: string
  value: string
  onChange: (v: string) => void
  suffix: string
}> = ({ label, value, onChange, suffix }) => (
  <VStack align="stretch" spacing={SPACING.xs}>
    <Text
      as="label"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize={TYPOGRAPHY.label}
      textTransform="uppercase"
      letterSpacing="0.28em"
      color={SEMANTIC_COLORS.textSecondary}
    >
      {label}
      <HStack spacing={SPACING.xs} mt={SPACING.xs}>
        <Input
          inputMode="decimal"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.small}
          borderRadius={0}
          border="1px solid"
          borderColor={SEMANTIC_COLORS.hairline}
          transition={TRANSITIONS.colorAndBorder}
          _focus={FOCUS_STYLES.ring}
          minH="44px"
        />
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          {suffix}
        </Text>
      </HStack>
    </Text>
  </VStack>
)

export const WhatIfSimulator: React.FC<{
  reserves: (XrayReserve & { stable: boolean })[]
  main: string
  ratioOnly?: boolean
}> = ({ reserves, main, ratioOnly = false }) => {
  const [move, setMove] = useState('-10')
  const [repay, setRepay] = useState('0')
  const [add, setAdd] = useState('0')
  const num = (s: string) => (Number.isFinite(Number(s)) ? Number(s) : 0)
  const out = useMemo(
    () =>
      applyWhatIf(
        reserves,
        { priceMovePct: num(move), repayUsd: num(repay), addCollateralUsd: num(add), ratioOnly },
        main,
      ),
    [reserves, move, repay, add, main, ratioOnly],
  )
  const liquidated = out.healthFactor !== null && out.healthFactor < 1
  return (
    <VStack align="stretch" spacing={SPACING.sm}>
      <Eyebrow>What if</Eyebrow>
      <SimpleGrid columns={{ base: 1, md: 3 }} spacing={SPACING.base}>
        <Field
          label={ratioOnly ? `${main} vs debt asset` : 'Non-stable prices'}
          value={move}
          onChange={setMove}
          suffix="%"
        />
        <Field label="Repay debt" value={repay} onChange={setRepay} suffix="USD" />
        <Field label={`Add ${main}`} value={add} onChange={setAdd} suffix="USD" />
      </SimpleGrid>
      <Box borderTop="1px solid" borderColor={SEMANTIC_COLORS.hairline} pt={SPACING.sm}>
        <SimpleGrid columns={{ base: 2, md: 3 }} spacing={SPACING.base}>
          <Stat
            label="Health factor"
            value={out.healthFactor === null ? 'no debt' : out.healthFactor.toFixed(3)}
            tone={liquidated ? 'bad' : 'default'}
            sub={liquidated ? 'liquidatable' : undefined}
          />
          <Stat
            label="Distance"
            value={liquidated ? 'past the line' : pct(out.distance)}
            sub={liquidated ? undefined : (out.band ?? undefined)}
          />
          <Stat
            label="Liquidation price"
            value={
              out.liquidationPrice === null
                ? '—'
                : `$${Number(out.liquidationPrice.toPrecision(5)).toLocaleString('en-US')}`
            }
          />
        </SimpleGrid>
      </Box>
      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.xs}
        color={SEMANTIC_COLORS.textTertiary}
      >
        {ratioOnly
          ? 'Collateral moves against the debt asset (the ratio); repayment is spread over the debt pro rata.'
          : 'Every non-stable price moves together, stables fixed; repayment is spread over the debt pro rata.'}
      </Text>
    </VStack>
  )
}
