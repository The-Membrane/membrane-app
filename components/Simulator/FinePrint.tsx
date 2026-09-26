// EVERY DISCLOSURE ON THIS PAGE, IN ONE PLACE, AT THE FOOT OF IT.
//
// The disclosures did not get smaller, they got moved. "What this is not" used to be
// the first thing on the screen; it is now the last, because a caveat at the top of a
// landing page is a caveat about nothing. The disclosure renders whether or not
// there is a run, with the full source detail available on demand.
//
// The first four lines are fixed and hand-written. Everything after them is generated:
// the engine's own caveats for this run, the unpriced legs, and the provenance strings
// the data carries. No number is stated here that the run did not produce.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import { GUARANTEE, type Provenance } from '@/lib/position-sim'
import { CORPUS_COVERAGE_LINE, CORPUS_WORSE_CONTEXT_LINE } from '@/lib/position-sim/oct10Totals'

import Stamp from './Stamp'

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10px',
  letterSpacing: '0.24em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

/** Fixed, and true whatever the run says. */
const STANDING = [
  'Membrane has no Ethereum mainnet deployment. Its liquidation lines are modelled, not live protocol settings.',
  'The price path is measured: 1-minute Chainlink rounds, 10-11 Oct 2025.',
  'The venue recall rate is an assumption and moves the result most.',
  'A simulation is not a forecast.',
]

/**
 * The rate disclosure — a STANDING line. Membrane does not charge 0%: it charges through
 * the deployment venues. The share is curator-set and not fixed pre-launch, so no share
 * number is printed; what IS verified is the shape (no interest on deployed debt,
 * revenue from yield) and the ORDER of loss — never an absolute 'cannot invert'
 * (owner correction Sep 2026).
 *
 * The 14 days of covered yield is the owner's own figure (owner statement 2026-09-12),
 * and it replaces the older, vaguer "curators cover it first through required bonds":
 * the borrower's benefit is TIME TO ACT, stated as a duration, not a bond mechanism.
 * Same source as CARRY_CLAIMS[0] in lib/position-sim/guarantee.ts — keep them equal.
 */
const CARRY_TERMS =
  'Membrane charges no interest on debt deployed in a canonical venue; it is paid a ' +
  "curator-set share of that venue's yield. In a worst case the spread can invert — " +
  'curators cover 14 days of yield to give the borrower time to act. ' +
  'Undeployed debt pays a curator-set base rate. Your rate moves in one case: a curator vault ' +
  'repriced to the avoidance rate (the AUM-weighted rate of the lowest-paying vaults), and a ' +
  "curator can change the yield split only with seven days' notice."

export interface FinePrintProps {
  /** Caveats the two runs recorded, already unioned and de-duplicated by the caller. */
  caveats: string[]
  /** Legs the measured window has no series for, held flat through the run. */
  unpricedSymbols: string[]
  /** Every provenance stamp on the page, in one row. */
  stamps: Provenance[]
  /** Where the borrow rate behind the cost headline came from, e.g. 'Aave V3 borrow
   *  rate read on-chain at snapshot.' Omitted when no cost line was printed. */
  borrowRateNote?: string
  /** Extra standing lines the page needs — one per bullet, no paragraphs. */
  extraNotes?: string[]
  /** The exact inputs used for this run, retained after removing the visible controls. */
  assumptionNote?: string
}

const Line: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    as="li"
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="12px"
    lineHeight={1.65}
    color={SEMANTIC_COLORS.textSecondary}
    maxW="92ch"
  >
    {children}
  </Text>
)

export const FinePrint: React.FC<FinePrintProps> = ({
  caveats,
  unpricedSymbols,
  stamps,
  borrowRateNote,
  extraNotes,
  assumptionNote,
}) => (
  <Box
    as="details"
    data-testid="sim-fineprint"
    borderTop="1px solid"
    borderBottom="1px solid"
    borderColor={SEMANTIC_COLORS.borderStrong}
    minW={0}
  >
    <Box
      as="summary"
      cursor="pointer"
      listStyleType="none"
      px={SPACING.base}
      py={SPACING.base}
      display="flex"
      justifyContent="space-between"
      alignItems="center"
      gap={SPACING.base}
      _focusVisible={{
        outline: '2px solid',
        outlineColor: SEMANTIC_COLORS.success,
        outlineOffset: '2px',
      }}
      sx={{ '&::-webkit-details-marker': { display: 'none' } }}
    >
      <Text as="span" {...HEAD} color={SEMANTIC_COLORS.textPrimary}>
        before you quote this
      </Text>
      <Text
        as="span"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11px"
        color={SEMANTIC_COLORS.warning}
      >
        read the method ↓
      </Text>
    </Box>

    <Box
      px={SPACING.base}
      pb={SPACING.base}
      display="grid"
      gridTemplateColumns="minmax(0, 1fr)"
      gap={SPACING.md}
    >
      <Box
        as="ul"
        minW={0}
        display="grid"
        gridTemplateColumns="minmax(0, 1fr)"
        gap={SPACING.sm}
        pl={SPACING.base}
        m={0}
      >
        {STANDING.map((s) => (
          <Line key={s}>{s}</Line>
        ))}
        {CORPUS_COVERAGE_LINE && <Line>{CORPUS_COVERAGE_LINE}</Line>}
        {CORPUS_WORSE_CONTEXT_LINE && <Line>{CORPUS_WORSE_CONTEXT_LINE}</Line>}
        {assumptionNote && <Line>{assumptionNote}</Line>}
        <Line>{CARRY_TERMS}</Line>
        {borrowRateNote && <Line>{borrowRateNote}</Line>}
        {(extraNotes ?? []).map((n) => (
          <Line key={n}>{n}</Line>
        ))}
        {unpricedSymbols.length > 0 && (
          <Line>Held flat — not priced by this dataset: {unpricedSymbols.join(', ')}.</Line>
        )}
        {caveats.map((c) => (
          <Line key={c}>{c}</Line>
        ))}
      </Box>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="12px"
        lineHeight={1.65}
        color={SEMANTIC_COLORS.textTertiary}
        maxW="92ch"
      >
        {GUARANTEE.provenance}
      </Text>

      <Box minW={0} display="grid" gridTemplateColumns="minmax(0, 1fr)" gap={SPACING.sm}>
        <Text {...HEAD}>where every number came from</Text>
        <Box minW={0} display="flex" gap={SPACING.sm} flexWrap="wrap">
          {stamps.map((p, k) => (
            <Stamp key={`${p.label}-${k}`} provenance={p} />
          ))}
        </Box>
      </Box>
    </Box>
  </Box>
)

export default FinePrint
