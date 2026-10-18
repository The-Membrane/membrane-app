import { Box, Button, Container, HStack, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import React, { useState } from 'react'

import { MockStamp } from '@/components/demo'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { MODELLED_FOOTNOTE } from '@/lib/position-sim/guarantee'

import { Caveats, Eyebrow } from './atoms'
import { PROTOCOL_NAME, ppWord, share, usd } from './format'
import { CohortLens } from './CohortLens'
import { DebtLens } from './DebtLens'
import { TimeLens } from './TimeLens'
import { ForecastGate } from './ForecastGate'
import { DesireRouter } from './DesireRouter'
import { useEvidence } from './useEvidence'
import { EvidenceDoc, Lens, ProtocolKey } from './types'

const PROTOCOLS: ProtocolKey[] = ['aave-v3', 'morpho-blue']

/** "OP 246 ($0.5M), ARB 216 ($0.5M), AAVE 81 ($7.0M)": the three largest groups, real side. */
const topThree = (top: { key: string; positions: number; realRepaidUsd: number }[]) =>
  top
    .slice(0, 3)
    .map((t) => `${t.key} ${t.positions.toLocaleString('en-US')} (${usd(t.realRepaidUsd)})`)
    .join(', ')

/** The published sensitivity at the protocols' own lines, on ITS OWN set, with the split. */
const protocolLineSentence = (d: EvidenceDoc) => {
  const r = d.meta.sensitivities.find((x) => x.key === 'protocol-line')
  if (!r) return ''
  return ` At the protocols\u2019 own lines on the real debt instead (its own ${r.positions.toLocaleString('en-US')} positions), the protocols closed ${share(r.realShare)} of the debt and Membrane would have closed ${share(r.memShare)}\u2020, ${ppWord(r.gapPp)}, net (Aave ${ppWord(r.byProtocol['aave-v3'].gapPp)}, Morpho ${ppWord(r.byProtocol['morpho-blue'].gapPp)}).`
}

/** "Aave 13.9 pp less · Morpho 50.3 pp less": the split beside every blended figure. */
const splitLine = (d: EvidenceDoc) =>
  PROTOCOLS.map(
    (k) => `${PROTOCOL_NAME[k].split(' ')[0]} ${ppWord(d.debt.byProtocol[k].gapPp)}`,
  ).join(' · ')

/**
 * The three lenses, as numbered section openers.
 *
 * Each tab carries its own headline figure, so the strip reads as a summary before
 * anything is clicked — you can see what a lens will tell you without opening it.
 * `metric` is derived from the loaded doc; nothing here is hardcoded.
 */
const LENSES: {
  id: Lens
  label: string
  heading: string
  blurb: string
  metric: (d: EvidenceDoc) => string
  caption: (d: EvidenceDoc) => string
}[] = [
  {
    id: 'debt',
    label: 'Debt closed',
    heading: 'How much of the loan gets closed',
    blurb:
      'The share of each side’s own debt closed: path-independent, so it holds whichever way the market goes next. A Membrane borrower carries less debt (sized to Membrane’s own, lower line†), so shares compare and dollars do not. Every sale is capped by the liquidity the day showed†.',
    // DIRECTION-AWARE: the gap can point either way per protocol and per chain, so the word
    // is computed from the sign, never typed.
    metric: (d) => `${share(d.debt.all.realShare)} → ${share(d.debt.all.memShare)}†`,
    caption: (d) => `of the debt closed · ${ppWord(d.debt.all.gapPp)}, net · ${splitLine(d)}`,
  },
  {
    id: 'time',
    label: 'Time granted',
    heading: 'What the delay did, position by position',
    blurb:
      'Aave and Morpho liquidate atomically, in the same block. Membrane grants an 8-hour delay inside a 4% band first (none for stablecoin collateral†), modelled here on the contract\u2019s own rules. Path-dependent; read the caveats.',
    metric: (d) => `$${Math.abs(d.time.oneRepay.delayCreditUsd / 1e6).toFixed(1)}M†`,
    caption: (d) =>
      `${d.time.oneRepay.delayCreditUsd < 0 ? 'more' : 'less'} debt closed than one repay to cap \u00b7 ` +
      `${d.time.neverSold.positions.toLocaleString('en-US')} positions never sold`,
  },
  {
    id: 'cohort',
    label: 'Every position',
    heading: 'All of them, including the losses',
    blurb:
      'Every position is here and filterable — including the ones where Membrane does worse. Check the claim rather than taking it.',
    metric: (d) => d.meta.positions.toLocaleString('en-US'),
    caption: (d) =>
      `real positions · ${d.debt.all.more.toLocaleString('en-US')} where Membrane closes a larger share`,
  },
]

export const Evidence: React.FC<{ initialDoc?: EvidenceDoc | null }> = ({ initialDoc }) => {
  const [lens, setLens] = useState<Lens>('debt')
  const { doc, error, isLoading } = useEvidence(initialDoc)

  const active = LENSES.find((l) => l.id === lens)!

  // One recorded call per browser. Persisted so a reload does not re-ask a question the
  // user already answered, and so the result can later feed the same Brier pipeline the
  // Builder uses (components/Builder/utils.ts brier()). Storage failures are swallowed:
  // a private-mode browser must not break the page over a telemetry nicety.
  const recordCall = React.useCallback((bandIndex: number, correct: boolean) => {
    try {
      window.localStorage.setItem(
        'membrane.evidence.firstCall',
        JSON.stringify({ bandIndex, correct }),
      )
    } catch {
      /* storage unavailable — the in-session reveal still works */
    }
  }, [])

  return (
    <Container maxW="1200px" py={SPACING.xl} px={SPACING_PATTERNS.pagePadding}>
      <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
        <VStack align="flex-start" spacing={SPACING.sm}>
          {/* No leading number here — the lens strip below owns 01/02/03, and two
              competing numbering schemes on one screen read as a mistake. */}
          <Eyebrow>Counterfactual · {doc?.meta.window.label ?? '10\u201311 Oct 2025'}</Eyebrow>
          <Text
            as="h1"
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h1}
            fontWeight={TYPOGRAPHY.bold}
            color={SEMANTIC_COLORS.textPrimary}
          >
            What our engine would have done
          </Text>
          {doc ? (
            <>
              {/* THE HEADLINE (owner default, 2026-10-16): the whole census leads, and the
                  Aave / Morpho split sits on the next line, always. Every figure is the
                  doc's. Both lines carry numbers, so both read in mono (CLAUDE.md: never a
                  number in the display serif). */}
              <Text
                data-testid="evidence-headline"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.h4}
                color={SEMANTIC_COLORS.textPrimary}
                maxW="760px"
                lineHeight="1.7"
              >
                {doc.meta.censusPositions.toLocaleString('en-US')} positions were liquidated on Aave
                and Morpho on {doc.meta.window.label}, four chains. On the{' '}
                {doc.meta.positions.toLocaleString('en-US')} Membrane can be walked on — at its own
                line, the debt sized to that line, every sale capped by the liquidity the day
                showed† — the protocols closed {share(doc.debt.all.realShare)} of the debt; Membrane
                would have closed {share(doc.debt.all.memShare)}† of its own —{' '}
                {ppWord(doc.debt.all.gapPp)}, net.
              </Text>
              <Text
                data-testid="evidence-split"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textSecondary}
                maxW="760px"
                lineHeight="1.7"
              >
                {PROTOCOLS.map((k) => {
                  const s = doc.debt.byProtocol[k]
                  return `${PROTOCOL_NAME[k]}: ${s.positions.toLocaleString('en-US')} positions, ${share(s.realShare)} \u2192 ${share(s.memShare)}\u2020 (${ppWord(s.gapPp)})`
                }).join(' · ')}
              </Text>
              {/* The gap is NET: show what it is made of, beside it (review 2026-10-16). */}
              <Text
                data-testid="evidence-gross"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
                maxW="760px"
                lineHeight="1.7"
              >
                {`Net of both directions: Membrane closes a smaller share on ${doc.debt.all.less.toLocaleString('en-US')} positions (there the protocols closed ${share(doc.debt.all.lessSet.realShare)}, Membrane ${share(doc.debt.all.lessSet.memShare)}\u2020) and a larger one on ${doc.debt.all.more.toLocaleString('en-US')} (${share(doc.debt.all.moreSet.realShare)} against ${share(doc.debt.all.moreSet.memShare)}\u2020); ${doc.debt.all.equal.toLocaleString('en-US')} are equal. The protocols repaid ${usd(doc.debt.all.realRepaidUsd)} on these positions; a Membrane dollar figure is not set beside it, because Membrane\u2019s borrower carries less debt. Debt repaid only: Membrane\u2019s liquidation fee is not assumed.`}
              </Text>
              {/* WHO IS NOT IN THE SET, on both sides (owner rulings 2026-10-18). */}
              <Text
                data-testid="evidence-excluded"
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textTertiary}
                maxW="760px"
                lineHeight="1.7"
              >
                {`Left out of both sides: ${doc.meta.exclusions.noMembraneLine.positions.toLocaleString('en-US')} positions whose collateral has no Membrane line (${usd(doc.meta.exclusions.noMembraneLine.realRepaidUsd)} repaid by the protocols; Aave ${doc.meta.exclusions.noMembraneLine.byProtocol['aave-v3'].positions.toLocaleString('en-US')}, Morpho ${doc.meta.exclusions.noMembraneLine.byProtocol['morpho-blue'].positions.toLocaleString('en-US')}), ${doc.meta.exclusions.partialMembraneLine.positions.toLocaleString('en-US')} holding some collateral without one (${usd(doc.meta.exclusions.partialMembraneLine.realRepaidUsd)}) and ${doc.meta.exclusions.noCapacity.positions.toLocaleString('en-US')} that would sell a token nobody liquidated on that chain (${usd(doc.meta.exclusions.noCapacity.realRepaidUsd)}). By main collateral, no line: ${topThree(doc.meta.exclusions.noMembraneLine.top)}; some collateral without one: ${topThree(doc.meta.exclusions.partialMembraneLine.top)}. ${protocolLineSentence(doc)}`}
              </Text>
              <MockStamp
                label={`on-chain · ${doc.meta.events.toLocaleString('en-US')} liquidation events · LTV walked on each protocol\u2019s own oracle · ${doc.meta.window.label}`}
              />
            </>
          ) : null}
        </VStack>

        {isLoading ? (
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
          >
            Loading the cohort…
          </Text>
        ) : null}

        {error ? (
          <Box
            border="1px solid"
            borderColor={SEMANTIC_COLORS.danger}
            p={SPACING_PATTERNS.cardPadding}
          >
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              color={SEMANTIC_COLORS.danger}
            >
              Could not load the dataset ({error}). Nothing is rendered rather than showing invented
              numbers.
            </Text>
          </Box>
        ) : null}

        {doc ? (
          <>
            {/* The first rep. Sits ABOVE the lens strip because the strip leaks the
                answer in its headline figures — asking after that is not a forecast,
                it is a reading comprehension test. See ForecastGate for why this is
                calibration against a settled fact rather than prediction. */}
            <ForecastGate
              realMedianFrac={doc.debt.all.medians.all.realMedianFrac}
              membraneMedianFrac={doc.debt.all.medians.all.memMedianFrac}
              split={PROTOCOLS.map((k) => ({
                label: PROTOCOL_NAME[k],
                realMedianFrac: doc.debt.byProtocol[k].medians.all.realMedianFrac,
                membraneMedianFrac: doc.debt.byProtocol[k].medians.all.memMedianFrac,
              }))}
              positions={doc.debt.all.medians.all.positions}
              membraneMore={doc.debt.all.more}
              onCommit={recordCall}
            />

            {/* Desire-router: three doors to the carry flows (owner-approved
                landing change). Mounted AFTER the gate so commit-before-reveal is
                untouched. */}
            <DesireRouter />

            {/* Numbered section-opener strip. Each tab shows its own headline figure,
                so the row reads as a summary before anything is clicked. Selection is
                a phosphor rule under the active tab — no lift, no glow. */}
            <SimpleGrid columns={{ base: 1, md: 3 }} spacing={SPACING.none}>
              {LENSES.map((l, i) => {
                const on = l.id === lens
                return (
                  <Button
                    key={l.id}
                    onClick={() => setLens(l.id)}
                    variant="unstyled"
                    h="auto"
                    textAlign="left"
                    whiteSpace="normal"
                    px={SPACING.base}
                    pt={SPACING.base}
                    pb={SPACING.md}
                    borderRadius={0}
                    borderTop="2px solid"
                    borderColor={on ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderSubtle}
                    bg={on ? SEMANTIC_COLORS.bgSecondary : 'transparent'}
                    transition={TRANSITIONS.colors}
                    _hover={{
                      borderColor: on ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderStrong,
                    }}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                    aria-pressed={on}
                  >
                    <VStack align="flex-start" spacing={SPACING.sm}>
                      <Eyebrow color={on ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary}>
                        {String(i + 1).padStart(2, '0')} / {l.label}
                      </Eyebrow>
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.h3}
                        fontWeight={TYPOGRAPHY.medium}
                        color={on ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
                        lineHeight="1.2"
                      >
                        {l.metric(doc)}
                      </Text>
                      <Text
                        fontFamily={TYPOGRAPHY.fontMono}
                        fontSize={TYPOGRAPHY.xs}
                        color={SEMANTIC_COLORS.textTertiary}
                        lineHeight="1.5"
                      >
                        {l.caption(doc)}
                      </Text>
                    </VStack>
                  </Button>
                )
              })}
            </SimpleGrid>

            {/* Section opener for the active lens: serif heading + italic sub-copy.
                Prose reads in serif; every number above it reads in mono. */}
            <VStack align="flex-start" spacing={SPACING.sm}>
              <Text
                fontFamily={TYPOGRAPHY.fontDisplay}
                fontSize={TYPOGRAPHY.h2}
                fontWeight={TYPOGRAPHY.semibold}
                color={SEMANTIC_COLORS.textPrimary}
              >
                {active.heading}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontDisplay}
                fontSize={TYPOGRAPHY.h4}
                fontStyle="italic"
                color={SEMANTIC_COLORS.textSecondary}
                maxW="680px"
                lineHeight="1.7"
              >
                {active.blurb}
              </Text>
            </VStack>

            {lens === 'debt' ? (
              <DebtLens debt={doc.debt} byAsset={doc.byAsset} meta={doc.meta} />
            ) : null}
            {lens === 'time' ? <TimeLens time={doc.time} meta={doc.meta} /> : null}
            {lens === 'cohort' ? (
              doc.cohort.length ? (
                <CohortLens rows={doc.cohort} />
              ) : (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Loading all {doc.meta.positions.toLocaleString('en-US')} positions…
                </Text>
              )
            ) : null}

            <Caveats items={doc.meta.caveats} />
            {/* The page's one footer line for every † above (DESIGN_RULES.md §3). */}
            <Text
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.xs}
              color={SEMANTIC_COLORS.textTertiary}
            >
              {MODELLED_FOOTNOTE}
            </Text>

            <Box
              borderTop="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              pt={SPACING_PATTERNS.cardPadding}
            >
              <VStack align="flex-start" spacing={SPACING.sm}>
                <Eyebrow>Method</Eyebrow>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                  lineHeight="1.8"
                  maxW="820px"
                >
                  {doc.meta.method}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textSecondary}
                  lineHeight="1.8"
                  maxW="820px"
                >
                  Prices: {doc.meta.oracle} Scope: {doc.meta.scope.line}.{' '}
                  {doc.meta.scope.outOfScope}
                </Text>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                  lineHeight="1.8"
                >
                  Borrow gap {doc.meta.params.borrowLtvGap * 100}pp ·{' '}
                  {doc.meta.realConstants.borrowLtvGapSource} · repay formula{' '}
                  {doc.meta.realConstants.repayFormulaSource} · cure window{' '}
                  {doc.meta.params.delaySeconds}s · {doc.meta.realConstants.cureWindowSource} ·
                  floor ${doc.meta.params.liqDebtMinimumUsd.toLocaleString('en-US')} ·{' '}
                  {doc.meta.realConstants.liqDebtMinimumSource}
                </Text>
                {/* The ONLY place an old-census figure appears, and only to explain why the
                    old headline moved. Labelled superseded (owner, 2026-10-16). */}
                <Box
                  borderLeft="2px solid"
                  borderColor={SEMANTIC_COLORS.warning}
                  pl={SPACING.base}
                  maxW="820px"
                  data-testid="evidence-old-census"
                >
                  <VStack align="flex-start" spacing={SPACING.xs}>
                    <Eyebrow color={SEMANTIC_COLORS.warning}>{doc.meta.crossCheck.label}</Eyebrow>
                    <Text
                      fontFamily={TYPOGRAPHY.fontMono}
                      fontSize={TYPOGRAPHY.xs}
                      color={SEMANTIC_COLORS.textSecondary}
                      lineHeight="1.8"
                    >
                      {doc.meta.crossCheck.line}
                    </Text>
                  </VStack>
                </Box>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.textTertiary}
                  lineHeight="1.8"
                  wordBreak="break-all"
                >
                  Source: {doc.meta.source.path} · sha256 {doc.meta.source.sha256.slice(0, 16)}… ·
                  built by {doc.meta.generatedBy} at code {doc.meta.code.commit.slice(0, 10)}
                </Text>
              </VStack>
            </Box>
          </>
        ) : null}
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          Data compiled by Membrane.
        </Text>
      </VStack>
    </Container>
  )
}
