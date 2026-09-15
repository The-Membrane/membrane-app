// BOND COVERAGE — the receipt for the curator bond.
//
// The headline ratio is a placeholder today, and says so. config/evm carries no
// CuratorRegistry address, so `totalBonded` and `reportedAum` cannot be read; the
// block prints the formula, the basis, the read path and a mock stamp instead of a
// number it cannot stand behind (facts.ts BOND_COVERAGE, docs/BADASS_RULESET.md §11).
//
// THE SEAM: pass `live` once the registry is wired and the same block renders the
// real redemption-basis ratio with an on-chain stamp. Nothing calls it with `live`
// today; the shape is here so wiring it is one prop rather than a rewrite.

import { Box, Grid, HStack, Text, VStack } from '@chakra-ui/react'
import React from 'react'

import { MockStamp } from '@/components/demo'
import { Eyebrow } from '@/components/Evidence/atoms'
import { Card } from '@/components/ui/Card'
import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING, SPACING_PATTERNS } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'

import { BOND_COVERAGE } from './facts'

/**
 * Provenance, one word. The contract path lives in the tooltip. Sixteen 9px file:line
 * stamps read as dust to a stranger; the proof links carry the visible evidence and this
 * keeps the exact cite one hover away for anyone checking.
 */
export const Cite: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <Text
    as="span"
    title={typeof children === 'string' ? children : undefined}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="9px"
    color={SEMANTIC_COLORS.textTertiary}
    letterSpacing="0.14em"
    textTransform="uppercase"
    textDecoration="underline dotted"
    textUnderlineOffset="3px"
    cursor="help"
  >
    source
  </Text>
)

export interface BondCoverageProps {
  /**
   * Live registry reads. When present the redemption basis is computed and stamped
   * on-chain; when absent the figure renders as a placeholder with a mock stamp.
   */
  live?: { totalBonded: bigint; totalAum: bigint }
}

/** HH:MM, local clock, for the on-chain stamp. Only reached on the client. */
const clock = (): string => {
  const d = new Date()
  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

export const BondCoverage: React.FC<BondCoverageProps> = ({ live }) => {
  const ratio = React.useMemo(() => {
    if (!live || live.totalAum === 0n) return null
    return Number(live.totalBonded) / Number(live.totalAum)
  }, [live])

  // The one em dash on this page, and it is a numeric placeholder rather than prose:
  // the slot where a ratio will print once the registry address exists.
  const figure = ratio === null ? '—' : `${(ratio * 100).toFixed(2)}%`
  const stampLabel =
    ratio === null
      ? 'mock · registry address pending'
      : `on-chain · fetched ${clock()}`

  return (
    <Card variant="default">
      <VStack align="stretch" spacing={SPACING_PATTERNS.sectionGap}>
        <VStack align="flex-start" spacing={SPACING.sm}>
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize={TYPOGRAPHY.h3}
            fontWeight={TYPOGRAPHY.semibold}
            color={SEMANTIC_COLORS.textPrimary}
          >
            {BOND_COVERAGE.title}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.small}
            color={SEMANTIC_COLORS.textSecondary}
            lineHeight="1.7"
          >
            {BOND_COVERAGE.definition}
          </Text>
        </VStack>

        <VStack align="flex-start" spacing={SPACING.xs}>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize={TYPOGRAPHY.body}
            color={SEMANTIC_COLORS.textPrimary}
            lineHeight="1.7"
            maxW="72ch"
          >
            {BOND_COVERAGE.backs}
          </Text>
          <Cite>{BOND_COVERAGE.backsCite}</Cite>
        </VStack>

        {/* The headline slot. A figure and its provenance on one baseline, so the
            number is never read without the stamp that qualifies it. The eyebrow names
            the slot, so an empty dash reads as "no value yet" rather than a stray rule. */}
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize={TYPOGRAPHY.label}
          letterSpacing="0.28em"
          textTransform="uppercase"
          color={SEMANTIC_COLORS.textTertiary}
        >
          coverage · redemption basis
        </Text>
        <HStack align="baseline" spacing={SPACING.base} flexWrap="wrap">
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="clamp(40px, 7vw, 72px)"
            lineHeight="1"
            letterSpacing="-0.02em"
            color={ratio === null ? SEMANTIC_COLORS.textTertiary : SEMANTIC_COLORS.success}
          >
            {figure}
          </Text>
          <Box as="span" title={`reads: ${BOND_COVERAGE.readPath}`}>
            <MockStamp label={stampLabel} />
          </Box>
        </HStack>

        <Grid templateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={SPACING_PATTERNS.sectionGap}>
          {BOND_COVERAGE.bases.map((b) => (
            <VStack
              key={b.id}
              align="flex-start"
              spacing={SPACING.sm}
              borderTop="1px solid"
              borderColor={SEMANTIC_COLORS.borderSubtle}
              pt={SPACING_PATTERNS.cardPadding}
            >
              <Eyebrow>{b.label}</Eyebrow>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.small}
                color={SEMANTIC_COLORS.textPrimary}
                lineHeight="1.7"
              >
                {b.formula}
              </Text>
              <Text
                fontFamily={TYPOGRAPHY.fontMono}
                fontSize={TYPOGRAPHY.xs}
                color={SEMANTIC_COLORS.textSecondary}
                lineHeight="1.7"
              >
                {b.answers}
              </Text>
              <Box borderLeft="2px solid" borderColor={SEMANTIC_COLORS.warning} pl={SPACING.md}>
                <Text
                  fontFamily={TYPOGRAPHY.fontMono}
                  fontSize={TYPOGRAPHY.xs}
                  color={SEMANTIC_COLORS.warning}
                  lineHeight="1.7"
                >
                  {b.caveat}
                </Text>
              </Box>
              <Cite>{b.cite}</Cite>
            </VStack>
          ))}
        </Grid>
      </VStack>
    </Card>
  )
}

export default BondCoverage
