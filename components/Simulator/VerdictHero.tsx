// THE VERDICT, AS THE HERO.
//
// CARRY-FIRST (owner ruling 2026-09-11: "if our initial product sale is the carry
// product, the landing page must be carry-first"). When the wallet on screen is paying
// a readable rate on debt that is actually deployed, the hero leads with THE BILL —
// what the source protocol charges this carry per year, and the fact that Membrane
// charges nothing on the deployed slice. The liquidation verdict does not disappear;
// it drops to the third line, because it is the SECOND reason to move, not the first.
//
// When there is no deployment or no readable rate, the cost lines are not printed at
// all — there is no fallback rate and no assumed deployment — and the hero reverts to
// exactly what it was: the safety verdict as the headline, the equity delta as the
// number. A cost sentence is only ever built out of numbers carryCost() actually had.
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
//
// MODE (owner ruling 2026-09-12 — "keep this build as a toggle flip in case we want to
// go back to borrower-first — or a separate page"): `mode` decides which of the two
// stories may lead.
//   'carry'    the carry branch leads WHEN ITS GATE PASSES (priced borrow + real
//              deployment), else the safety verdict, exactly as before.
//   'borrower' the safety verdict is ALWAYS the headline. The carry branch never
//              renders, even when the numbers are there; the cost, when there is one,
//              drops to the 15px secondary line under the delta.
// The gate itself is unchanged — mode only decides whether a PASSED gate is allowed to
// take the headline.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { LANDING_SIM_MODE, type SimMode } from '@/config/simulatorMode'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { tabular } from '@/components/Builder/styles'
import { fmtUtcMinute, outcomeLine, type CarryCost, type Comparison } from '@/lib/position-sim'

import AddressBar, { type AddressBarProps } from './AddressBar'
import HeroChart from './HeroChart'
import { usd, usdSigned } from './format'

/**
 * THE ONE LINE THAT SELLS THE PRODUCT before the sim proves it. Owner copy, verbatim,
 * 2026-09-12 — exported because the CTA repeat at the foot of the page renders the same
 * sentence and the two must never drift apart.
 */
export const HERO_SUBHEAD =
  'Levered yield that recalls debt instead of liquidating you. First, see what the rails ' +
  'would have done to your current position.'

export interface VerdictHeroProps extends AddressBarProps {
  /** The run. Null while the measured price path is still loading. */
  comparison: Comparison | null
  /** What this carry costs today, and what the deployed slice costs on Membrane. */
  carry?: CarryCost | null
  /** Which story is allowed to lead. See the MODE note at the top of this file. */
  mode?: SimMode
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
function verdict(cmp: Comparison, isDemo: boolean): {
  first: string
  second: string
  firstColor: string
  secondColor: string
} {
  const o = outcomeLine(cmp)
  const src = cmp.position.label
  const whose = isDemo ? 'this' : 'your'
  const sold = (run: typeof cmp.source) =>
    run.events.filter((e) => e.kind === 'liquidation').reduce((a, e) => a + e.seizedUsd, 0)
  const at = o.source.firstAt !== null ? ` at ${fmtUtcMinute(o.source.firstAt).replace(/^\d+ \w+ /, '')}` : ''
  // Hopkins: a specific number beats an adjective. Hormozi: name the outcome the
  // reader wants — collateral kept — not the mechanism that keeps it.
  const first = o.source.liquidated
    ? `${src} sold ${usd(sold(cmp.source))} of ${whose} collateral${at}.`
    : `${src} sold nothing.`
  const second = o.membrane.liquidated
    ? `Membrane would have sold ${usd(sold(cmp.membrane))}.`
    : 'Membrane would have sold $0.'
  return {
    first,
    second,
    firstColor: o.source.liquidated ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary,
    secondColor: o.membrane.liquidated ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.success,
  }
}

export const VerdictHero: React.FC<VerdictHeroProps> = ({
  comparison,
  carry,
  mode = LANDING_SIM_MODE,
  isDemo,
  startTs,
  stepSeconds,
  errors,
  ...addressBar
}) => {
  const v = comparison ? verdict(comparison, isDemo) : null
  const delta = comparison?.equityDeltaUsd ?? 0
  const deltaColor =
    delta > 0
      ? SEMANTIC_COLORS.success
      : delta < 0
        ? SEMANTIC_COLORS.danger
        : SEMANTIC_COLORS.textPrimary

  // The gate: a priced borrow AND a real deployment. Otherwise the cost story is
  // unavailable, not small, and it is not told.
  const carryPriced = !!carry && carry.annualCostUsd > 0 && carry.coveredDebtUsd > 0 && !!comparison
  // …and in borrower mode a passed gate still never takes the headline.
  const carryFirst = carryPriced && mode === 'carry'
  const src = comparison?.position.label ?? ''
  const whose = isDemo ? 'this' : 'your'

  return (
    <Box
      pt={SPACING.lg}
      display="grid"
      gridTemplateColumns="1fr"
      gap={{ base: SPACING.base, md: SPACING.lg }}
      alignItems="center"
    >
      <Box display="grid" gap={SPACING.base} alignContent="center">
        {/* THE SUBHEAD (borrower mode only). Owner layout ruling 2026-09-12: one landing
            page — the hero SELLS the carry product by name, then the sim PROVES the rails
            with the borrow verdict below it. One line, above the headline, nothing else
            added to the hero. Verbatim; do not paraphrase. */}
        {mode === 'borrower' && (
          <Text
            data-testid="sim-hero-subhead"
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="14.5px"
            lineHeight={1.55}
            maxW="70ch"
            color={SEMANTIC_COLORS.textSecondary}
          >
            {HERO_SUBHEAD}
          </Text>
        )}

        {v && carryFirst && carry && (
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
              <Text as="span" color={SEMANTIC_COLORS.danger}>
                {src} charges {whose} carry {usd(carry.annualCostUsd)} a year, even when the venue pays nothing.
              </Text>{' '}
              <Text as="span" color={SEMANTIC_COLORS.success}>
                Membrane is paid out of the yield. If the spread ever inverts, curator bonds eat it before you do.
              </Text>
            </Text>

            <Box display="grid" gap={SPACING.xs}>
              <Text
                data-testid="sim-carry-cost"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="clamp(36px, 6vw, 64px)"
                lineHeight={1.02}
                {...tabular}
                color={SEMANTIC_COLORS.danger}
              >
                −{usd(carry.fixedCostOnCoveredUsd)}/yr
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                letterSpacing="0.06em"
                color={SEMANTIC_COLORS.textSecondary}
              >
                fixed interest on the deployed {usd(carry.coveredDebtUsd)}, {src}, paid or not
              </Text>
            </Box>

            {/* The second reason, not the first — same sentence the headline used to
                be, at reading size. */}
            <Text
              data-testid="sim-safety-verdict"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="15px"
              lineHeight={1.55}
              maxW="70ch"
            >
              <Text as="span" color={v.firstColor}>
                {v.first}
              </Text>{' '}
              <Text as="span" color={v.secondColor}>
                {v.second}
              </Text>
            </Text>
          </>
        )}

        {v && !carryFirst && (
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
                kept, Membrane vs {comparison?.position.label}
              </Text>
            </Box>

            {/* BORROWER MODE, WALLET THAT ALSO HAS A CARRY. The cost story does not
                disappear — it becomes the second reason, at reading size. Printed only
                when carryCost() actually had the numbers; never a fallback rate. */}
            {carryPriced && carry && (
              <Text
                data-testid="sim-carry-secondary"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="15px"
                lineHeight={1.55}
                maxW="70ch"
              >
                <Text as="span" color={SEMANTIC_COLORS.danger}>
                  {src} also charges {whose} carry {usd(carry.fixedCostOnCoveredUsd)} a year in
                  fixed interest on the deployed {usd(carry.coveredDebtUsd)}, paid or not.
                </Text>{' '}
                <Text as="span" color={SEMANTIC_COLORS.success}>
                  Membrane is paid out of the yield. If the spread ever inverts, curator bonds eat
                  it before you do.
                </Text>
              </Text>
            )}
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
