// THE VERDICT, AS THE HERO.
//
// /simulator is a landing page, and a landing page opens on the diagnosis. Two columns:
// the verdict, the dollar gap and the paste card on the left; the animated equity graph
// on the right. No eyebrow, no H1 sentence, no disclosure paragraph — the disclosures
// are all still on the page, at the foot of it, where they can be read rather than
// stepped over.
//
// Every sentence here is derived from the run (outcomeLine + equityDeltaUsd). Nothing
// in this file states a claim about the protocol that the run did not produce — the
// named guarantee lives in GuaranteeBlock and comes from GUARANTEE verbatim.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { tabular } from '@/components/Builder/styles'
import { outcomeLine, type Comparison } from '@/lib/position-sim'

import AddressBar, { type AddressBarProps } from './AddressBar'
import HeroChart from './HeroChart'
import { usdSigned } from './format'

export interface VerdictHeroProps extends AddressBarProps {
  /** The run. Null while the measured price path is still loading. */
  comparison: Comparison | null
  isDemo: boolean
  /** Price-path origin, for the chart's x axis. Null until the path lands. */
  startTs: number | null
  stepSeconds: number | null
  /** Page-level failures (scenario, adapters). One line each, danger, no explanation. */
  errors?: string[]
}

/**
 * Two sentences. The first is the source engine's ending, taken verbatim from the
 * clause `outcomeLine` already built (so the hero and the run panel can never
 * disagree). The second names Membrane's ending in the same breath.
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
  startTs,
  stepSeconds,
  errors,
  ...addressBar
}) => {
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
      pt={SPACING.lg}
      display="grid"
      gridTemplateColumns={{ base: '1fr', md: '55fr 45fr' }}
      gap={{ base: SPACING.base, md: SPACING.lg }}
      alignItems="center"
    >
      <Box display="grid" gap={SPACING.base} alignContent="center">
        {v && (
          <>
            <Text
              data-testid="sim-verdict-headline"
              as="h1"
              fontFamily={TYPOGRAPHY.fontDisplay}
              fontSize="clamp(30px, 5vw, 54px)"
              lineHeight={1.08}
              letterSpacing="-0.015em"
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
                fontSize="clamp(36px, 6vw, 64px)"
                lineHeight={1.02}
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
              >
                ending equity, Membrane vs {comparison?.position.label}
              </Text>
            </Box>
          </>
        )}

        <AddressBar {...addressBar} />

        {(errors ?? []).map((e) => (
          <Text
            key={e}
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.danger}
            lineHeight={1.6}
          >
            {e}
          </Text>
        ))}
      </Box>

      <HeroChart
        comparison={comparison}
        startTs={startTs}
        stepSeconds={stepSeconds}
        isDemo={isDemo}
      />
    </Box>
  )
}

export default VerdictHero
