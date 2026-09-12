// THE RUN: same position, same prices, two liquidation engines.
//
// Stripped to the three numbers that decide whether the reader believes the hero —
// what each engine ended with, how many times it seized collateral, and what that cost
// — plus the two share actions and the way out to /builder.
//
// The caveats that used to live in this block did not disappear: the engine's own
// caveat list and the "read this before you quote the number" disclosure are rendered
// in full by FinePrint at the foot of the page. They are not collapsed anywhere.

import React from 'react'
import { Box, Button, Text } from '@chakra-ui/react'
import NextLink from 'next/link'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { tabular } from '@/components/Builder/styles'
import { outcomeLine, type Comparison, type SimRun } from '@/lib/position-sim'

import Stamp from './Stamp'
import { usd } from './format'

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

const BTN = {
  bg: 'transparent',
  border: '1px solid',
  borderColor: SEMANTIC_COLORS.borderStrong,
  color: SEMANTIC_COLORS.textPrimary,
  borderRadius: 0,
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '10px',
  letterSpacing: '0.14em',
  textTransform: 'uppercase' as const,
  h: 'auto',
  px: SPACING.md,
  py: SPACING.sm,
  transition: TRANSITIONS.colors,
  _hover: {
    borderColor: SEMANTIC_COLORS.success,
    color: SEMANTIC_COLORS.success,
    bg: 'transparent',
  },
  _active: { opacity: 0.85 },
  _focus: FOCUS_STYLES.ring,
}

const Row: React.FC<{ label: string; value: string; color?: string }> = ({
  label,
  value,
  color,
}) => (
  <Box
    display="flex"
    justifyContent="space-between"
    gap={SPACING.md}
    py={SPACING.xs}
    borderBottom="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
  >
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textSecondary}>
      {label}
    </Text>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="12.5px"
      {...tabular}
      color={color ?? SEMANTIC_COLORS.textPrimary}
    >
      {value}
    </Text>
  </Box>
)

/** Only collateral-seizing events count as liquidations — a recall or a cure is not one. */
const liquidations = (run: SimRun): number =>
  run.events.filter((e) => e.kind === 'liquidation').length

const EngineColumn: React.FC<{ run: SimRun; title: string; accent: string }> = ({
  run,
  title,
  accent,
}) => (
  <Box
    border="1px solid"
    borderColor={SEMANTIC_COLORS.borderSubtle}
    bg={SEMANTIC_COLORS.bgPrimary}
    p={SPACING.md}
    display="grid"
    gap={SPACING.sm}
    alignContent="start"
  >
    <Box
      display="flex"
      justifyContent="space-between"
      alignItems="baseline"
      gap={SPACING.sm}
      flexWrap="wrap"
    >
      <Text {...HEAD} color={accent}>
        {title}
      </Text>
      <Stamp provenance={run.provenance} />
    </Box>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="clamp(20px, 3vw, 28px)"
      {...tabular}
      color={accent}
    >
      {usd(run.endEquityUsd)}
    </Text>
    <Box mt={SPACING.xs}>
      <Row label="end equity" value={usd(run.endEquityUsd)} />
      <Row
        label="liquidations"
        value={liquidations(run).toLocaleString('en-US')}
        color={liquidations(run) > 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}
      />
      <Row
        label="penalties"
        value={usd(run.penaltyPaidUsd)}
        color={run.penaltyPaidUsd > 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}
      />
    </Box>
  </Box>
)

export interface ComparisonPanelProps {
  comparison: Comparison
  onSaveCard: () => void
  onCopyLink: () => void
  copyState: 'idle' | 'copied' | 'failed'
}

export const ComparisonPanel: React.FC<ComparisonPanelProps> = ({
  comparison,
  onSaveCard,
  onCopyLink,
  copyState,
}) => {
  const { chainName } = useChainRoute()
  const { source, membrane } = comparison
  const outcome = outcomeLine(comparison)

  return (
    <Box
      bg={SEMANTIC_COLORS.bgSecondary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p={SPACING.base}
      display="grid"
      gap={SPACING.base}
    >
      <Text
        data-testid="sim-outcome-line"
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="13px"
        lineHeight={1.6}
        color={
          outcome.membrane.liquidated
            ? SEMANTIC_COLORS.danger
            : outcome.source.liquidated
              ? SEMANTIC_COLORS.warning
              : SEMANTIC_COLORS.textPrimary
        }
      >
        {outcome.line}
      </Text>

      <Box display="grid" gridTemplateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={SPACING.md}>
        <EngineColumn
          run={source}
          title={comparison.position.label}
          accent={SEMANTIC_COLORS.textPrimary}
        />
        <EngineColumn run={membrane} title="Membrane" accent={SEMANTIC_COLORS.success} />
      </Box>

      <Box display="flex" gap={SPACING.sm} flexWrap="wrap">
        <Button type="button" onClick={onSaveCard} {...BTN}>
          Save share card
        </Button>
        <Button type="button" onClick={onCopyLink} {...BTN}>
          {copyState === 'copied'
            ? 'Link copied'
            : copyState === 'failed'
              ? 'Copy failed — select the URL'
              : 'Copy link'}
        </Button>
        <NextLink href={`/${chainName}/builder`} style={{ textDecoration: 'none' }}>
          <Button as="span" type="button" {...BTN}>
            Build it → /builder
          </Button>
        </NextLink>
      </Box>
    </Box>
  )
}

export default ComparisonPanel
