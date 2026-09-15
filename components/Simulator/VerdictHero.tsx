// THE VERDICT, AS THE HERO.
//
// CARRY-FIRST (owner ruling 2026-09-11: "if our initial product sale is the carry
// product, the landing page must be carry-first"). When the wallet on screen is paying
// a readable rate on debt that is actually deployed, the hero leads with THE BILL —
// what the source protocol charges this carry per year, and the fact that Membrane
// charges nothing on the deployed slice.
//
// The carry hero is now EXACTLY five things (owner ruling 2026-09-12 — "it all just
// blends in"): cost line 1, cost line 2, the big fixed-cost number, the paste card, the
// chart. The Oct-10 safety verdict that used to trail it at 15px is GONE from this
// branch — one hero makes one argument, and the liquidation story has a whole section
// of its own below the fold. Do not re-add it here.
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
//
// HERO VARIANT (owner brief 2026-09-12 — the liquidation-history proof: "test this as
// the hero as well"). `heroVariant` is the A/B, orthogonal to `mode`:
//   'oct10'    the measured stress-window verdict, exactly as above.
//   'history'  the address's OWN liquidation history leads: "$X of your collateral
//              would still be yours", the big number is X, and the Oct 10 verdict drops
//              to the 15px secondary line — the same demotion the carry hero applies.
// The history hero OUTRANKS the carry hero when both gates pass: a claim about events
// that actually happened to this wallet beats a claim about a day and a bill.
//
// THE GUARD THAT MAKES IT SAFE TO SHIP: the history hero renders ONLY on a landed,
// positive savedUsd. Still loading, scan failed, or nothing was saved (which is most
// wallets — most have never been liquidated at all) and it falls straight back to the
// Oct 10 verdict. There is no path to an empty hero and no path to a "$0" hero.

import type { MeasuredCensus } from '@/lib/position-sim/demoBorrower'
import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import {
  HERO_VARIANT,
  LANDING_SIM_MODE,
  type HeroVariant,
  type SimMode,
} from '@/config/simulatorMode'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { tabular } from '@/components/Builder/styles'
import { fmtUtcMinute, outcomeLine, type CarryCost, type Comparison } from '@/lib/position-sim'
import { OCT10_STAKES_LINE } from '@/lib/position-sim/oct10Totals'

import AddressBar, { type AddressBarProps } from './AddressBar'
import HeroChart from './HeroChart'
import { historyDate } from './HistoryProof'
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
  /** Landing hero form: the page above already carries the dek, so the sim's own
   *  subhead is suppressed. /simulator keeps it (owner layout ruling 2026-09-12). */
  hideSubhead?: boolean
  /** Hero form under a page h1: the verdict is evidence, not the headline. Serif
   *  lines drop to h2 scale, the figure to 40px, and the block left-aligns to the h1. */
  compact?: boolean
  /**
   * WHICH PROOF LEADS (owner brief 2026-09-12: "test this as the hero as well").
   * 'oct10' is the measured stress window; 'history' is the address's own liquidation
   * history. See the HERO VARIANT note below.
   */
  heroVariant?: HeroVariant
  /** The secondary proof, already fetched by the page. Only read in 'history'. */
  history?: {
    savedUsd: number
    savedCount: number
    firstEventTs: number | null
    /** True while the scan is in flight. A loading hero falls back to Oct 10. */
    loading: boolean
  } | null
  isDemo: boolean
  /** The census's measured figures for the demo wallet; null for a pasted address. */
  measured?: MeasuredCensus | null
  /** Price-path origin, for the chart's x axis. Null until the path lands. */
  startTs: number | null
  stepSeconds: number | null
  /** Page-level failures (scenario, adapters). One line each, danger, no explanation. */
  errors?: string[]
}

/**
 * THREE LINES, AND BOTH CLOSES ARE ON THEM (owner ruling 2026-09-14).
 *
 * This used to print one number: "Membrane would've saved you +$X", in success green,
 * and never said what Membrane ALSO closed. On the hero wallet Membrane closes six
 * figures of the same loan; a verdict that prints only the gap is selling the difference
 * while hiding one of the two terms that make it. So the verdict now states both:
 *
 *   1  blood     what the source protocol closed, and at what minute.
 *   2  bone      what Membrane would have closed, and how much later.
 *   3  phosphor  the equity gap, with the price basis it is measured at.
 *
 * "Closed" is DEBT RETIRED, not collateral seized — the same quantity the Oct 10 census
 * publishes as aaveClosedUsd / membraneClosedUsd, so a reader can put the hero next to
 * its census row and read the same units. Membrane's figure sums every repay, including
 * one answered by venue capital: a dollar of loan closed by a recall is still closed.
 *
 * Every figure is the RUN's, not the fixture's. The fixture's census numbers are a
 * different question (what the census measured) and are checked against this run in
 * scripts/tests/position-sim.test.ts rather than printed here.
 */
function verdict(
  cmp: Comparison,
  isDemo: boolean,
  measured: MeasuredCensus | null,
  startTs: number | null,
  stepSeconds: number | null,
): {
  first: string
  second: string
  figure: string
  caption: string
  firstColor: string
  secondColor: string
  figureColor: string
} {
  const o = outcomeLine(cmp)
  const src = cmp.position.label
  const whose = isDemo ? 'this' : 'your'
  /** Debt retired. The source engine only ever emits liquidations; Membrane may also
   *  retire debt through a recall or a cure, and those close the loan too. */
  const sourceClosed = cmp.source.events
    .filter((e) => e.kind === 'liquidation')
    .reduce((a, e) => a + e.repaidUsd, 0)
  const membraneCloses = cmp.membrane.events.filter((e) => e.repaidUsd > 0)
  const membraneClosed = membraneCloses.reduce((a, e) => a + e.repaidUsd, 0)
  const sourceFirst = cmp.source.events.find((e) => e.kind === 'liquidation') ?? null
  const clock = (ts: number) => fmtUtcMinute(ts).replace(/^\d+ \w+ /, '')

  // Past tense needs a measured figure. The demo wallet carries the census's sum of
  // Aave's real events; a pasted address only has the run's replay of Aave's mechanics,
  // which is a model, so it is written as one.
  const measuredTs =
    measured && startTs !== null && stepSeconds !== null ? startTs + measured.t0Index * stepSeconds : null
  const first = measured && measuredTs !== null
    ? `${src} closed ${usd(measured.aaveClosedUsd)} of this loan at ${clock(measuredTs)}, measured.`
    : o.source.liquidated && sourceFirst
      ? `${src} would have closed ${usd(sourceClosed)} of ${whose} loan at ${clock(sourceFirst.ts)}.`
      : `${src} closes nothing.`

  // The lag is the whole mechanism: the delay window is time, and time is what the
  // reader is being sold. State it in minutes, off the two runs' own event stamps.
  const lag =
    sourceFirst && membraneCloses.length ? membraneCloses[0].minute - sourceFirst.minute : null
  const plural = (n: number) => (n === 1 ? 'minute' : 'minutes')
  let tail: string
  if (membraneClosed <= 0) tail = 'and sold nothing'
  else if (lag === null) tail = membraneCloses.length ? `at ${clock(membraneCloses[0].ts)}` : 'and nothing more'
  else if (lag > 0) tail = `${lag} ${plural(lag)} later`
  else if (lag < 0) tail = `${-lag} ${plural(-lag)} earlier`
  else tail = 'and nothing more'
  const second = `Membrane would have closed ${usd(membraneClosed)} ${tail}.`

  // The gap, and the prices it is read at. An equity delta is a difference between two
  // balance sheets at ONE moment; the moment is the last minute of the measured path,
  // and the caption says so rather than leaving the reader to assume "today".
  const delta = cmp.equityDeltaUsd
  const n = cmp.source.equitySeries.length
  const endTs = startTs !== null && stepSeconds !== null && n > 0 ? startTs + (n - 1) * stepSeconds : null
  const basis = endTs !== null ? `${fmtUtcMinute(endTs)} prices` : 'the last price of the measured path'
  const caption = `${delta < 0 ? 'less' : 'more'} equity left at ${basis}`

  return {
    first,
    second,
    figure: usdSigned(delta),
    caption,
    firstColor: o.source.liquidated ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary,
    // BONE, not green. Line 2 is what Membrane also took; colouring it as a win is the
    // exact thing this rewrite removes.
    secondColor: SEMANTIC_COLORS.textPrimary,
    figureColor:
      delta > 0 ? SEMANTIC_COLORS.success : delta < 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary,
  }
}

export const VerdictHero: React.FC<VerdictHeroProps> = ({
  comparison,
  carry,
  mode = LANDING_SIM_MODE,
  heroVariant = HERO_VARIANT,
  history,
  isDemo,
  startTs,
  stepSeconds,
  errors,
  hideSubhead = false,
  measured = null,
  compact = false,
  ...addressBar
}) => {
  const v = comparison ? verdict(comparison, isDemo, measured, startTs, stepSeconds) : null
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

  // HERO VARIANT — the A/B (owner brief 2026-09-12).
  //
  // The history hero leads ONLY on a positive, landed number. `savedUsd === 0`, a scan
  // still in flight, a failed scan (the page passes savedUsd 0 for all three) — every
  // one of them falls through to the Oct 10 verdict. That is the whole guard against
  // the failure mode this variant invites: a hero that reads "$0" or blanks entirely on
  // the majority of wallets, which have never been liquidated at all.
  const historyFirst =
    heroVariant === 'history' && !!history && !history.loading && history.savedUsd > 0

  // …and in borrower mode a passed gate still never takes the headline. The history
  // hero outranks the carry hero too: it is the more specific claim about this wallet.
  const carryFirst = carryPriced && mode === 'carry' && !historyFirst
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
      {/* Everything above the graph is centred (owner, 2026-09-12). */}
      <Box display="grid" gap={SPACING.base} alignContent="center" justifyItems={compact ? 'start' : 'center'} textAlign={compact ? 'left' : 'center'}>
        {/* THE SUBHEAD (borrower mode only). Owner layout ruling 2026-09-12: one landing
            page — the hero SELLS the carry product by name, then the sim PROVES the rails
            with the borrow verdict below it. One line, above the headline, nothing else
            added to the hero. Verbatim; do not paraphrase. */}
        {mode === 'borrower' && !hideSubhead && (
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

        {/* HISTORY HERO. The claim is about events that actually happened to this
            address, so it outranks both the Oct 10 counterfactual and the carry bill.
            The Oct 10 verdict does not disappear — it drops to the 15px line, exactly
            where the safety verdict sits in the carry hero. */}
        {historyFirst && history && (
          <>
            <Text
              data-testid="sim-verdict-headline"
              as="h1"
              fontFamily={TYPOGRAPHY.fontDisplay}
              fontSize={compact ? TYPOGRAPHY.h2 : 'clamp(30px, 5vw, 54px)'}
              lineHeight={1.08}
              letterSpacing="-0.015em"
              color={SEMANTIC_COLORS.success}
              sx={{ textWrap: 'balance' }}
            >
              {usd(history.savedUsd)} of your collateral would still be yours.
            </Text>

            <Box display="grid" gap={SPACING.xs}>
              <Text
                data-testid="sim-history-hero-number"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={compact ? '40px' : 'clamp(36px, 6vw, 64px)'}
                lineHeight={1.02}
                {...tabular}
                color={SEMANTIC_COLORS.success}
              >
                {usd(history.savedUsd)}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                letterSpacing="0.06em"
                color={SEMANTIC_COLORS.textSecondary}
              >
                {history.savedCount} liquidation{history.savedCount === 1 ? '' : 's'}
                {history.firstEventTs ? ` since ${historyDate(history.firstEventTs)}` : ''}.
                Membrane would have recalled instead of selling.
              </Text>
            </Box>

            {/* The Oct 10 verdict, demoted. Same sentences, reading size. */}
            {v && (
              <Text
                data-testid="sim-safety-verdict"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="15px"
                lineHeight={1.55}
                maxW="70ch"
              >
                <Text as="span" display="block" color={v.firstColor}>
                  {v.first}
                </Text>
                <Text as="span" display="block" color={v.secondColor}>
                  {v.second}
                </Text>
                <Text as="span" display="block" color={v.figureColor}>
                  {v.figure}{' '}
                  <Text as="span" color={SEMANTIC_COLORS.textSecondary}>
                    {v.caption}
                  </Text>
                </Text>
              </Text>
            )}
          </>
        )}

        {v && carryFirst && carry && (
          <>
            <Text
              data-testid="sim-verdict-headline"
              as="h1"
              fontFamily={TYPOGRAPHY.fontDisplay}
              fontSize={compact ? TYPOGRAPHY.h2 : 'clamp(30px, 5vw, 54px)'}
              lineHeight={1.08}
              letterSpacing="-0.015em"
              sx={{ textWrap: 'balance' }}
            >
              <Text as="span" color={SEMANTIC_COLORS.danger}>
                {src} charges {whose} carry {usd(carry.annualCostUsd)} a year, even when the venue pays nothing.
              </Text>{' '}
              {/* The 14 days is the owner's own figure (owner statement 2026-09-12);
                  CARRY_CLAIMS[0] and FinePrint's CARRY_TERMS carry the same number and
                  the three must never drift. It replaces "curator bonds eat it before
                  you do" — the borrower's benefit is TIME, not a bond. */}
              <Text as="span" color={SEMANTIC_COLORS.success}>
                Membrane is paid out of the yield. If the spread inverts, curators cover 14 days of
                yield to give you time to act.
              </Text>
            </Text>

            <Box display="grid" gap={SPACING.xs}>
              <Text
                data-testid="sim-carry-cost"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={compact ? '40px' : 'clamp(36px, 6vw, 64px)'}
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

            {/* NOTHING ELSE. The Oct-10 safety verdict used to sit here at 15px; the
                owner removed it 2026-09-12 ("it all just blends in"). The carry hero is
                cost line 1, line 2, the number, the paste card, the chart. */}
          </>
        )}

        {v && !carryFirst && !historyFirst && (
          <>
            {/* THE STAKES (owner ruling 2026-09-12): the hero must say how big that day
                was and that it WAS Oct 10, before it says what happened to this wallet.
                One line, above the two verdict sentences, nothing added to it — the
                verdict stays the headline. Numbers come from OCT10_TOTALS, which the
                unit test re-derives from the evidence JSON. */}
            <Text
              data-testid="sim-oct10-stakes"
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="12.5px"
              letterSpacing="0.04em"
              lineHeight={1.5}
              color={SEMANTIC_COLORS.textSecondary}
            >
              {OCT10_STAKES_LINE}
            </Text>

            <Text
              data-testid="sim-verdict-headline"
              as="h1"
              fontFamily={TYPOGRAPHY.fontDisplay}
              fontSize={compact ? TYPOGRAPHY.h2 : 'clamp(30px, 5vw, 54px)'}
              lineHeight={1.08}
              letterSpacing="-0.015em"
              sx={{ textWrap: 'balance' }}
            >
              <Text as="span" display="block" color={v.firstColor}>
                {v.first}
              </Text>
              <Text as="span" display="block" color={v.secondColor}>
                {v.second}
              </Text>
            </Text>

            <Box display="grid" gap={SPACING.xs}>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={compact ? '40px' : 'clamp(36px, 6vw, 64px)'}
                lineHeight={1.02}
                {...tabular}
                color={deltaColor}
              >
                {v.figure}
              </Text>
              <Text
                data-testid="sim-verdict-basis"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize="11px"
                letterSpacing="0.06em"
                color={SEMANTIC_COLORS.textSecondary}
              >
                {v.caption}
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
                {/* Same sentence as the carry hero, same source: owner statement
                    2026-09-12 for the 14 days. Keep the two in lockstep. */}
                <Text as="span" color={SEMANTIC_COLORS.success}>
                  Membrane is paid out of the yield. If the spread inverts, curators cover 14 days
                  of yield to give you time to act.
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
