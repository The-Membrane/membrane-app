// THE VERDICT, AS THE HERO.
//
// /simulator is a landing page, and a landing page opens on the diagnosis — not on a
// feature demo. This block is the first thing under the H1: what happened to THIS
// position on its own protocol, what would have happened on Membrane, and the dollar
// gap between the two endings.
//
// Every sentence here is derived from the run (outcomeLine + equityDeltaUsd). Nothing
// in this file states a claim about the protocol that the run did not produce — the
// named guarantee lives in GuaranteeBlock and comes from GUARANTEE verbatim.
//
// The address bar lives INSIDE the hero: reading your own address is the one action
// this page asks for, so it sits with the verdict rather than below it.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow, monoXs, tabular } from '@/components/Builder/styles'
import { outcomeLine, type Comparison } from '@/lib/position-sim'

import AddressBar, { type AddressBarProps } from './AddressBar'
import { shortAddress, usdSigned } from './format'

const PROVENANCE_LINE =
  'measured 1-minute Chainlink rounds · Membrane line is modelled, not live · a simulation is not a forecast'

export interface VerdictHeroProps extends AddressBarProps {
  /** The run. Null while the measured price path is still loading. */
  comparison: Comparison | null
  isDemo: boolean
  /** The selected position's protocol label, shown while there is no run yet. */
  positionLabel: string | null
}

/**
 * Two sentences. The first is the source engine's ending, taken verbatim from the
 * clause `outcomeLine` already built (so the hero and section 03 can never disagree).
 * The second names Membrane's ending in the same breath.
 */
function verdict(cmp: Comparison): {
  first: string
  second: string
  firstColor: string
  secondColor: string
} {
  const o = outcomeLine(cmp)
  const first = `${o.line.split(' · ')[0]}.`
  const second = o.source.liquidated
    ? o.membrane.liquidated
      ? 'Would have been liquidated on Membrane too.'
      : 'Would have held on Membrane.'
    : o.membrane.liquidated
      ? 'Membrane would have liquidated it.'
      : 'Would have held on both.'
  return {
    first,
    second,
    firstColor: o.source.liquidated ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary,
    secondColor: o.membrane.liquidated ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success,
  }
}

export const VerdictHero: React.FC<VerdictHeroProps> = ({
  comparison,
  isDemo,
  positionLabel,
  ...addressBar
}) => {
  const label = isDemo
    ? 'worked example · 10-11 oct 2025'
    : `${shortAddress(addressBar.loadedAddress ?? '')} · 10-11 oct 2025`

  const v = comparison ? verdict(comparison) : null
  const delta = comparison?.equityDeltaUsd ?? 0
  const deltaColor =
    delta > 0
      ? SEMANTIC_COLORS.success
      : delta < 0
        ? SEMANTIC_COLORS.danger
        : SEMANTIC_COLORS.textPrimary

  return (
    <Box
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      bg={SEMANTIC_COLORS.bgSecondary}
      borderRadius={0}
      px={{ base: SPACING.base, md: SPACING.lg }}
      py={{ base: SPACING.base, md: SPACING.lg }}
      display="grid"
      gap={SPACING.base}
    >
      <Text {...eyebrow}>{label}</Text>

      {v ? (
        <>
          <Text
            data-testid="sim-verdict-headline"
            as="h2"
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize="clamp(26px, 4.4vw, 44px)"
            lineHeight={1.12}
            letterSpacing="-0.01em"
            sx={{ textWrap: 'balance' }}
          >
            <Text as="span" color={v.firstColor}>
              {v.first}
            </Text>{' '}
            <Text as="span" color={v.secondColor}>
              {v.second}
            </Text>
          </Text>

          <Box display="grid" gap={SPACING.xs}>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="clamp(28px, 5.6vw, 48px)"
              lineHeight={1.05}
              {...tabular}
              color={deltaColor}
            >
              {usdSigned(delta)}
            </Text>
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11px"
              letterSpacing="0.06em"
              color={SEMANTIC_COLORS.textSecondary}
              lineHeight={1.7}
              maxW="72ch"
            >
              difference in ending equity — same prices, two engines
            </Text>
          </Box>
        </>
      ) : (
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="13px"
          color={SEMANTIC_COLORS.textSecondary}
          lineHeight={1.8}
          maxW="76ch"
        >
          Reading the measured October 2025 price path…
          {positionLabel
            ? ` The ${positionLabel} position is loaded and runs the moment it lands.`
            : ''}
        </Text>
      )}

      <Box display="grid" gap={SPACING.sm}>
        <Text {...monoXs} lineHeight={1.7} maxW="82ch">
          {isDemo
            ? 'This is the worked example. Paste your address for your own verdict — read-only, no wallet, no signature.'
            : 'Paste another address, or go back to the worked example.'}
        </Text>
        <AddressBar {...addressBar} />
      </Box>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="10.5px"
        color={SEMANTIC_COLORS.textTertiary}
        lineHeight={1.7}
        maxW="86ch"
      >
        {PROVENANCE_LINE}
      </Text>
    </Box>
  )
}

export default VerdictHero
