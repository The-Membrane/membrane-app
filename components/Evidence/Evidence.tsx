import { Box, Button, Container, HStack, SimpleGrid, Text, VStack } from '@chakra-ui/react'
import React, { useState } from 'react'

import { MockStamp } from '@/components/demo'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Caveats, Eyebrow } from './atoms'
import { usd } from './format'
import { CohortLens } from './CohortLens'
import { DebtLens } from './DebtLens'
import { TimeLens } from './TimeLens'
import { useEvidence } from './useEvidence'
import { EvidenceDoc, Lens } from './types'

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
      'Path-independent, so it holds whichever way the market goes next. This is the one to lead with.',
    metric: (d) => usd(d.debt.differenceUsd),
    caption: (d) => `less debt closed · ${d.debt.differencePct}%`,
  },
  {
    id: 'time',
    label: 'Time granted',
    heading: 'What eight hours would have caught',
    blurb:
      'Aave liquidates atomically, in the same block. Membrane grants a real 8-hour cure window first. Path-dependent — read the caveats.',
    metric: (d) => `${d.time.healthyAt8hPct}%`,
    caption: (d) => `still healthy at 8h · of ${d.time.accountsAnalysed.toLocaleString()}`,
  },
  {
    id: 'cohort',
    label: 'Every account',
    heading: 'All of them, including the losses',
    blurb:
      'Every account is here and filterable — including the ones where Membrane does worse. Check the claim rather than taking it.',
    metric: (d) => d.debt.accounts.toLocaleString(),
    caption: (d) => `real accounts · ${d.debt.membraneClosesMore} where we lose`,
  },
]

/**
 * The counterfactual, made traversable.
 *
 * Protocol-scoped and identical with or without a wallet, so it opens fully
 * populated for a stranger (V20). There is no demo state here to fake — every
 * number is derived from real liquidations that really happened.
 */
export const Evidence: React.FC<{ initialDoc?: EvidenceDoc | null }> = ({ initialDoc }) => {
  const [lens, setLens] = useState<Lens>('debt')
  const { doc, error, isLoading } = useEvidence(initialDoc)

  const active = LENSES.find((l) => l.id === lens)!

  return (
    <Container maxW="1200px" py={SPACING.xl} px={SPACING_PATTERNS.pagePadding}>
      <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
        <VStack align="flex-start" spacing={SPACING.sm}>
          {/* No leading number here — the lens strip below owns 01/02/03, and two
              competing numbering schemes on one screen read as a mistake. */}
          <Eyebrow>Counterfactual · 10 Oct 2025</Eyebrow>
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h1}
            fontWeight={TYPOGRAPHY.bold}
            color={SEMANTIC_COLORS.textPrimary}
          >
            What our engine would have done
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h4}
            fontStyle="italic"
            color={SEMANTIC_COLORS.textSecondary}
            maxW="720px"
            lineHeight="1.7"
          >
            On 10 October 2025, Aave liquidated {doc?.meta.accounts.toLocaleString() ?? '—'}{' '}
            accounts across four chains. Every one of them is below, replayed through
            Membrane&rsquo;s liquidation engine on the same measured prices, judged against its
            own liquidation line.
          </Text>
          {doc ? (
            <MockStamp
              label={`on-chain · ${doc.meta.sourceEvents.toLocaleString()} liquidation events · ${doc.meta.window}`}
            />
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
              Could not load the dataset ({error}). Nothing is rendered rather than showing
              invented numbers.
            </Text>
          </Box>
        ) : null}

        {doc ? (
          <>
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
                    _hover={{ borderColor: on ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderStrong }}
                    _active={ACTIVE_EFFECTS.dim}
                    _focus={FOCUS_STYLES.ring}
                    aria-pressed={on}
                  >
                    <VStack align="flex-start" spacing={SPACING.sm}>
                      <Eyebrow
                        color={on ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.textTertiary}
                      >
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

            {lens === 'debt' ? <DebtLens debt={doc.debt} byAsset={doc.byAsset} /> : null}
            {lens === 'time' ? <TimeLens time={doc.time} /> : null}
            {lens === 'cohort' ? (
              doc.cohort.length ? (
                <CohortLens rows={doc.cohort} />
              ) : (
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.small}
                  color={SEMANTIC_COLORS.textSecondary}
                >
                  Loading all {doc.debt.accounts.toLocaleString()} accounts…
                </Text>
              )
            ) : null}

            <Caveats items={doc.meta.caveats} />

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
                  color={SEMANTIC_COLORS.textTertiary}
                  lineHeight="1.8"
                >
                  Borrow gap {doc.meta.realConstants.borrowLtvGap * 100}pp ·{' '}
                  {doc.meta.realConstants.borrowLtvGapSource} · repay formula{' '}
                  {doc.meta.realConstants.repayFormulaSource} · cure window{' '}
                  {doc.meta.realConstants.cureWindowSeconds}s ·{' '}
                  {doc.meta.realConstants.cureWindowSource}
                </Text>
              </VStack>
            </Box>
          </>
        ) : null}
      </VStack>
    </Container>
  )
}
