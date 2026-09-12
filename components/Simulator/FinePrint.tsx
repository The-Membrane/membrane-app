// EVERY DISCLOSURE ON THIS PAGE, IN ONE PLACE, AT THE FOOT OF IT.
//
// The disclosures did not get smaller, they got moved. "What this is not" used to be
// the first thing on the screen; it is now the last, because a caveat at the top of a
// landing page is a caveat about nothing. Nothing here is collapsed, and this section
// renders whether or not there is a run — an unrun page still makes claims.
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

import Stamp from './Stamp'

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10px',
  letterSpacing: '0.2em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

/** Fixed, and true whatever the run says. */
const STANDING = [
  'Membrane has no Ethereum mainnet deployment. Its lines here are modelled and editable above.',
  'The price path is measured: 1-minute Chainlink rounds, 10-11 Oct 2025.',
  'The venue recall rate is an assumption and moves the result most.',
  'A simulation is not a forecast.',
]

export interface FinePrintProps {
  /** Caveats the two runs recorded, already unioned and de-duplicated by the caller. */
  caveats: string[]
  /** Legs the measured window has no series for, held flat through the run. */
  unpricedSymbols: string[]
  /** Every provenance stamp on the page, in one row. */
  stamps: Provenance[]
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

export const FinePrint: React.FC<FinePrintProps> = ({ caveats, unpricedSymbols, stamps }) => (
  <Box
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    p={SPACING.base}
    display="grid"
    gap={SPACING.md}
  >
    <Text {...HEAD}>before you quote this</Text>

    <Box as="ul" display="grid" gap={SPACING.sm} pl={SPACING.base} m={0}>
      {STANDING.map((s) => (
        <Line key={s}>{s}</Line>
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

    <Box display="grid" gap={SPACING.sm}>
      <Text {...HEAD}>where every number came from</Text>
      <Box display="flex" gap={SPACING.sm} flexWrap="wrap">
        {stamps.map((p, k) => (
          <Stamp key={`${p.label}-${k}`} provenance={p} />
        ))}
      </Box>
    </Box>
  </Box>
)

export default FinePrint
