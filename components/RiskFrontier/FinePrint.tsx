// Cold tier (VETERAN_UX_RULESET V9): where the numbers come from, behind one toggle.
// Mirrors the MASTER / INTENDED / MODELLED / OMITTED blocks of lib/position-sim/stressGrid.ts.

import React, { useState } from 'react'
import { Box, Button, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Panel } from './atoms'
import { STRESS_CODE_VERSION, STRESS_LABEL } from './viewModel'

const LINES = (tapeWindow: string | null): { head: string; body: string }[] => [
  {
    head: 'What a node is',
    body: `A sandbox position plus one named scenario, walked step by step through the same delay timer as the Oct 10 census. Every node is a ${STRESS_LABEL}, reproduces from its cell key, and carries the code base: ${STRESS_CODE_VERSION}. No probabilities, weights or win rates are computed.`,
  },
  {
    head: 'Owner-ruled rules, not yet on master',
    body: 'A recall asks the venues only for what restores the borrow LTV (line − 3pp); master asks for the whole debt. A liquidation never leaves debt between zero and the debt minimum: it repays all, and when a recall comes back short of that the rest is sold from collateral; master has no such guard, in the repay or the recall. Each gap has a fix lane.',
  },
  {
    head: 'Modelled, not measured',
    body: 'Membrane is not on mainnet, so every LTV and line here is modelled. Venue recall is a stock, min(deployed, exit capacity × multiplier), drawn down and never refilled across the horizon; a freeze starts at the first breach. Debt is held at $1 and the price shape moves the whole collateral. After a shape ends the price holds for one window plus a step.',
  },
  {
    head: 'Exit capacity: cash vs book (the default)',
    body: "Each measured level is one real stress event at a real venue (Aave, Spark, Steakhouse), 2023–2026: its idle cash across the first 8 hours, with an hourly keeper retry, set against Membrane's whole book at that venue ($10M, $50M or $250M; $50M by default). A recall gets min(1, cash ÷ book) of what it deployed. Assumed: (i) the whole book recalls at once, which is conservative; (ii) the cash observed in an hour is first come and already net of everyone else who withdrew in it; (iii) Membrane's recall does not itself start a run; (iv) the stock never refills across the horizon. Where the cash covered the whole book the level reads ×1, and says so. A level at 1% or less also gives no recall for its measured lock. These describe past stress, not the next one.",
  },
  {
    head: 'Exit capacity: the floor',
    body: "Everyone exits: every depositor races for the exit at once and a recall gets its pro-rata share, the venue's cash divided by everything deposited. It is not what depositors could actually withdraw in those events. On the same event it never pays more than cash vs book for a book the venue could hold. A book larger than the venue's whole supply could not exist there, since Membrane's deposit is part of that supply: those levels (some $250M books) are marked 'book exceeds the venue', and on the same event they are the only ones that pay less than everyone exits. The ×1 bound (everything comes back in every scenario) is an upper bound, never a default. The grid's capacity cuts are measured from the default venue, not named; the tree's everyone-exits lane runs the venue and level you chose.",
  },
  {
    head: 'Left out',
    body: 'The keeper fee ramp, gas stipend and protocol liquidation fee (all paid from collateral, so "sold" understates what leaves), interest accrual, the gas-indexed debt floor, slippage and MEV.',
  },
  {
    head: 'Distances',
    body: 'Each figure is the largest whole unit with no trigger, so the edge lies just past it: rounded toward risk. Venue axes are solved at a named −25% step, never folded into one combined route.',
  },
  {
    head: 'Oct 10 replay',
    body: `The measured ETH oracle path${tapeWindow ? ` (${tapeWindow})` : ''}, relative to its first observation: the shape of the crash, not its price level. A mechanical sensitivity test, not a forecast.`,
  },
  {
    head: 'Also not modelled yet',
    body: 'Live venue reads and staleness hatching, the 7-day trend line, change cards, the novelty banner, LST exit queues and oracle-lag scenarios. This page is a sandbox for the engine only.',
  },
]

export const FinePrint: React.FC<{ tapeWindow: string | null }> = ({ tapeWindow }) => {
  const [open, setOpen] = useState(false)
  return (
    <Panel>
      <Button
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        variant="unstyled"
        display="block"
        textAlign="left"
        w="100%"
        h="auto"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize={TYPOGRAPHY.label}
        letterSpacing="0.24em"
        textTransform="uppercase"
        fontWeight={400}
        color={SEMANTIC_COLORS.textSecondary}
        _hover={{ color: SEMANTIC_COLORS.textPrimary }}
        _focusVisible={FOCUS_STYLES.ring}
      >
        {open ? '−' : '+'} where these numbers come from
      </Button>
      {open && (
        <Box display="grid" gap={SPACING.sm} mt={SPACING.md}>
          {LINES(tapeWindow).map((l) => (
            <Box key={l.head}>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                letterSpacing="0.16em"
                textTransform="uppercase"
                color={SEMANTIC_COLORS.textTertiary}
              >
                {l.head}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.label}
                color={SEMANTIC_COLORS.textSecondary}
                lineHeight={1.6}
                mt={SPACING.xs}
              >
                {l.body}
              </Text>
            </Box>
          ))}
        </Box>
      )}
    </Panel>
  )
}
