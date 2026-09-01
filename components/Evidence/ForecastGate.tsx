// The first rep.
//
// WHY THIS EXISTS. Everything else on this page is a demonstration that the PROTOCOL is
// better. The user reads it and learns nothing they can attribute to themselves — it
// fails acceptance test 2 (docs/BADASS_RULESET.md §12): "does the user believe THEY
// caused the improvement?". A page that only proves the product is good is, by §0, the
// wrong feature. This asks the user to commit to a number BEFORE the reveal, so the rest
// of the page becomes feedback on a call they made rather than a claim they were handed.
//
// WHY THIS IS NOT PREDICTION. §1 forbids training prediction in low-validity domains.
// This is the opposite: the answer is a measured, settled fact from 10 Oct 2025. Guessing
// it is calibration against ground truth with instant unambiguous feedback — the textbook
// high-validity case. It teaches the one thing the ruleset names as the core borrower
// skill and the whole differentiator: how much of a loan a liquidation actually closes.
//
// It is NOT A GATE despite the name — skipping reveals the page immediately and the
// answer is never withheld. V20 demo-first forbids blocking content on an interaction.

import React, { useState } from 'react'
import { Box, Button, HStack, Text, VStack } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { ACTIVE_EFFECTS, FOCUS_STYLES, HOVER_EFFECTS, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'

import { Eyebrow } from './atoms'
import { pct } from './format'

/** Coarse bands, not a slider. */
const BANDS = [
  { lo: 0, hi: 0.2, label: 'under 20%' },
  { lo: 0.2, hi: 0.4, label: '20 – 40%' },
  { lo: 0.4, hi: 0.6, label: '40 – 60%' },
  { lo: 0.6, hi: 0.8, label: '60 – 80%' },
  { lo: 0.8, hi: 1, label: 'over 80%' },
] as const

export interface ForecastGateProps {
  /** Aave's measured median closed fraction — the ground truth being guessed. */
  aaveMedianFrac: number
  /** Membrane's counterfactual median on the same accounts. */
  membraneMedianFrac: number
  /** Fired once when the user commits, so the call can be recorded. */
  onCommit?: (bandIndex: number, correct: boolean) => void
}

const bandFor = (frac: number) => BANDS.findIndex((b) => frac >= b.lo && frac < b.hi)

export const ForecastGate: React.FC<ForecastGateProps> = ({
  aaveMedianFrac,
  membraneMedianFrac,
  onCommit,
}) => {
  const [picked, setPicked] = useState<number | null>(null)
  const truthBand = bandFor(aaveMedianFrac)

  const commit = (i: number) => {
    if (picked !== null) return
    setPicked(i)
    onCommit?.(i, i === truthBand)
  }

  // ---- after the call: the reveal is feedback on THEIR number ----------------
  if (picked !== null) {
    const right = picked === truthBand
    // Distance in bands, so "one off" reads differently from "the other end".
    const off = Math.abs(picked - truthBand)
    return (
      <Box
        border="1px solid"
        borderColor={right ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderStrong}
        p={SPACING_PATTERNS.cardPadding}
      >
        <VStack align="flex-start" spacing={SPACING.sm}>
          <Eyebrow color={right ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.warning}>
            {right ? 'You called it' : off === 1 ? 'One band off' : 'Not close'}
          </Eyebrow>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textPrimary}
            lineHeight="1.8"
          >
            You said <strong>{BANDS[picked].label}</strong>. Aave closed a median of{' '}
            <Text as="span" color={SEMANTIC_COLORS.danger}>
              {pct(aaveMedianFrac)}
            </Text>{' '}
            of each account&rsquo;s debt. Membrane&rsquo;s engine closes{' '}
            <Text as="span" color={SEMANTIC_COLORS.success}>
              {pct(membraneMedianFrac)}
            </Text>{' '}
            on the same accounts at the same prices.
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.xs}
            color={SEMANTIC_COLORS.textTertiary}
            lineHeight="1.7"
          >
            {right
              ? 'That intuition is the skill this page is about. The lenses below are the evidence behind it — including the 105 accounts where our engine does worse.'
              : 'Most people guess low, because "liquidation" sounds like a trim rather than most of the loan. That gap is the thing worth internalising — carry it into the lenses below.'}
          </Text>
        </VStack>
      </Box>
    )
  }

  // ---- before the call: one question, five buttons, no prose ------------------
  return (
    <Box
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderStrong}
      p={SPACING_PATTERNS.cardPadding}
    >
      <VStack align="flex-start" spacing={SPACING.md}>
        <VStack align="flex-start" spacing={SPACING.xs}>
          <Eyebrow>Before you look</Eyebrow>
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h4}
            color={SEMANTIC_COLORS.textPrimary}
          >
            When Aave liquidated one of these accounts, how much of the loan did it close?
          </Text>
        </VStack>

        <HStack spacing={SPACING.sm} flexWrap="wrap">
          {BANDS.map((b, i) => (
            <Button
              key={b.label}
              onClick={() => commit(i)}
              variant="outline"
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize={TYPOGRAPHY.small}
              fontWeight={TYPOGRAPHY.normal}
              transition={TRANSITIONS.colors}
              _hover={HOVER_EFFECTS.borderHighlight}
              _active={ACTIVE_EFFECTS.dim}
              _focus={FOCUS_STYLES.ring}
            >
              {b.label}
            </Button>
          ))}
        </HStack>

        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.xs}
          color={SEMANTIC_COLORS.textTertiary}
        >
          Answered on 2,350 real accounts. Skip by scrolling — nothing here is withheld.
        </Text>
      </VStack>
    </Box>
  )
}
