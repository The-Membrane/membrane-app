// The side-by-side: same position, same prices, two liquidation engines.
//
// Every caveat either run recorded is printed here, in full, above the fold of the
// block rather than behind a toggle. The moment a caveat is collapsible it stops being
// read, and these are the sentences that keep the number honest.

import React from 'react'
import { Box, Button, Text } from '@chakra-ui/react'
import NextLink from 'next/link'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { useChainRoute } from '@/hooks/useChainRoute'
import { eyebrow, monoXs, tabular } from '@/components/Builder/styles'
import { CURE_WINDOW_HOURS, type Comparison, type SimRun } from '@/lib/position-sim'

import Stamp from './Stamp'
import { pct, usd, usdSigned } from './format'

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
    <Text {...monoXs}>equity at the end of the window</Text>
    <Box mt={SPACING.sm}>
      <Row label="equity at the start" value={usd(run.startEquityUsd)} />
      <Row
        label="lost to liquidation penalties"
        value={usd(run.penaltyPaidUsd)}
        color={run.penaltyPaidUsd > 0 ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}
      />
      <Row label="events fired" value={run.events.length.toLocaleString('en-US')} />
      <Row label="peak ltv" value={pct(run.peakLtv)} />
      <Row label="collateral left" value={usd(run.endCollateralUsd)} />
      <Row label="debt left" value={usd(run.endDebtUsd)} />
      <Row
        label="position wiped"
        value={run.wiped ? 'yes' : 'no'}
        color={run.wiped ? SEMANTIC_COLORS.danger : SEMANTIC_COLORS.textPrimary}
      />
    </Box>
  </Box>
)

export interface ComparisonPanelProps {
  comparison: Comparison
  isDemo: boolean
  onSaveCard: () => void
  onCopyLink: () => void
  copyState: 'idle' | 'copied' | 'failed'
}

export const ComparisonPanel: React.FC<ComparisonPanelProps> = ({
  comparison,
  isDemo,
  onSaveCard,
  onCopyLink,
  copyState,
}) => {
  const { chainName } = useChainRoute()
  const { source, membrane, equityDeltaUsd: delta } = comparison
  const deltaColor =
    delta > 0
      ? SEMANTIC_COLORS.success
      : delta < 0
        ? SEMANTIC_COLORS.danger
        : SEMANTIC_COLORS.textPrimary
  const headline =
    delta > 0
      ? 'Membrane kept more of it.'
      : delta < 0
        ? 'Membrane kept less of it.'
        : 'Both engines landed level.'

  // Every caveat, from both runs, de-duplicated only where the two runs recorded the
  // identical sentence. Nothing is dropped.
  const caveats = Array.from(new Set([...source.caveats, ...membrane.caveats]))

  return (
    <Box
      bg={SEMANTIC_COLORS.bgSecondary}
      border="1px solid"
      borderColor={SEMANTIC_COLORS.borderSubtle}
      p={SPACING.base}
      display="grid"
      gap={SPACING.base}
    >
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="baseline"
        gap={SPACING.md}
        flexWrap="wrap"
      >
        <Text {...eyebrow}>03 / two engines, one price path</Text>
        <Box display="flex" gap={SPACING.sm} flexWrap="wrap">
          <Button type="button" onClick={onCopyLink} {...BTN}>
            {copyState === 'copied'
              ? 'Link copied'
              : copyState === 'failed'
                ? 'Copy failed — select the URL'
                : 'Copy link'}
          </Button>
          <Button type="button" onClick={onSaveCard} {...BTN}>
            Save share card
          </Button>
          <NextLink href={`/${chainName}/builder`} style={{ textDecoration: 'none' }}>
            <Button as="span" type="button" {...BTN}>
              build it → /builder
            </Button>
          </NextLink>
        </Box>
      </Box>

      <Box display="grid" gap={SPACING.sm}>
        <Text
          fontFamily={TYPOGRAPHY.fontDisplay}
          fontSize="clamp(21px, 3.4vw, 30px)"
          lineHeight={1.15}
          color={SEMANTIC_COLORS.textPrimary}
        >
          {headline}
        </Text>
        <Text {...HEAD}>difference in ending equity</Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="clamp(30px, 6vw, 52px)"
          lineHeight={1.05}
          {...tabular}
          color={deltaColor}
        >
          {usdSigned(delta)}
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11.5px"
          color={SEMANTIC_COLORS.textSecondary}
          lineHeight={1.7}
          maxW="80ch"
        >
          {comparison.scenarioLabel}. The price move is identical in both runs, so this gap is what
          the two engines did when the line was crossed — not a different market.
        </Text>
      </Box>

      {/* The disclosure that governs the number above it. Never collapsed. */}
      <Box
        border="1px solid"
        borderColor={SEMANTIC_COLORS.warning}
        bg={SEMANTIC_COLORS.bgPrimary}
        px={SPACING.md}
        py={SPACING.md}
        display="grid"
        gap={SPACING.xs}
      >
        <Text {...HEAD} color={SEMANTIC_COLORS.warning}>
          read this before you quote the number
        </Text>
        <Text
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11.5px"
          color={SEMANTIC_COLORS.textPrimary}
          lineHeight={1.75}
          maxW="82ch"
        >
          Membrane has no Ethereum mainnet deployment. There is no live per-asset max LTV to read,
          so the Membrane line used here is our assumption — you can change it in the controls, and
          the result changes with it. The venue recall rate is an input too, and it moves this
          figure more than anything else on the page. A simulation is not a forecast: the edge shown
          here is the edge of a model over one measured window, and that is not the same thing as
          the edge you would get live.
          {isDemo ? ' This run is the worked example, not a wallet.' : ''}
        </Text>
      </Box>

      <Box display="grid" gridTemplateColumns={{ base: '1fr', md: '1fr 1fr' }} gap={SPACING.md}>
        <EngineColumn
          run={source}
          title={comparison.position.label}
          accent={SEMANTIC_COLORS.textPrimary}
        />
        <EngineColumn run={membrane} title="Membrane" accent={SEMANTIC_COLORS.success} />
      </Box>

      <Text
        fontFamily={TYPOGRAPHY.fontMono}
        fontSize="11.5px"
        color={SEMANTIC_COLORS.textSecondary}
        lineHeight={1.75}
        maxW="86ch"
      >
        What differs: the source protocol repays a close-factor share of the whole loan and the
        liquidator takes the bonus on top. Membrane repays only enough to restore the borrow cap,
        recalls liquid value from deployment venues before it sells any collateral, and allows a{' '}
        {CURE_WINDOW_HOURS}-hour window to cure a breach before collateral is touched.
      </Text>

      {comparison.unpricedSymbols.length > 0 && (
        <Box
          border="1px solid"
          borderColor={SEMANTIC_COLORS.warning}
          px={SPACING.md}
          py={SPACING.sm}
          display="grid"
          gap={SPACING.xs}
        >
          <Text {...HEAD} color={SEMANTIC_COLORS.warning}>
            held flat — not priced by this dataset
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontMono}
            fontSize="11.5px"
            color={SEMANTIC_COLORS.textPrimary}
            lineHeight={1.7}
          >
            {comparison.unpricedSymbols.join(', ')}. The measured window has no series for{' '}
            {comparison.unpricedSymbols.length > 1 ? 'these assets' : 'this asset'}, so{' '}
            {comparison.unpricedSymbols.length > 1 ? 'they were' : 'it was'} held at the opening
            price for the whole run rather than approximated from a correlated series. Both engines
            see the same flat leg, but a position leaning on{' '}
            {comparison.unpricedSymbols.length > 1 ? 'these' : 'this'} is understressed here.
          </Text>
        </Box>
      )}

      <Box display="grid" gap={SPACING.sm}>
        <Text {...HEAD}>what this run could not model</Text>
        <Box as="ul" display="grid" gap={SPACING.sm} pl={SPACING.base} m={0}>
          {caveats.map((c) => (
            <Text
              as="li"
              key={c}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="11px"
              color={SEMANTIC_COLORS.textSecondary}
              lineHeight={1.75}
              maxW="86ch"
            >
              {c}
            </Text>
          ))}
        </Box>
      </Box>
    </Box>
  )
}

export default ComparisonPanel
