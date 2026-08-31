// One ProtocolPosition, rendered as the position ledger it is.
//
// Every risk parameter shown here (liquidation threshold, max LTV, liquidation bonus)
// was read from the source protocol by its adapter. Where a protocol does not expose
// one, the cell says so rather than filling in a number.

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { FOCUS_STYLES, TRANSITIONS } from '@/config/transitions'
import { TYPOGRAPHY } from '@/helpers/typography'
import { eyebrow, monoXs, tabular } from '@/components/Builder/styles'
import type { ProtocolPosition } from '@/lib/position-sim'

import Stamp from './Stamp'
import { amt, pct, usd } from './format'

const HEAD = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '9px',
  letterSpacing: '0.18em',
  textTransform: 'uppercase' as const,
  color: SEMANTIC_COLORS.textSecondary,
}

const CELL = {
  fontFamily: TYPOGRAPHY.fontMono,
  fontSize: '11.5px',
  color: SEMANTIC_COLORS.textPrimary,
  ...tabular,
}

const Metric: React.FC<{ label: string; value: string; note?: string; color?: string }> = ({
  label,
  value,
  note,
  color,
}) => (
  <Box bg={SEMANTIC_COLORS.bgSecondary} px={SPACING.md} py={SPACING.sm} display="grid" gap="3px">
    <Text {...HEAD}>{label}</Text>
    <Text
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="16px"
      {...tabular}
      color={color ?? SEMANTIC_COLORS.textPrimary}
    >
      {value}
    </Text>
    {note && <Text {...monoXs}>{note}</Text>}
  </Box>
)

export interface PositionCardProps {
  position: ProtocolPosition
  /** Rendered as a selectable row when there is more than one position. */
  selectable?: boolean
  selected?: boolean
  onSelect?: () => void
}

export const PositionCard: React.FC<PositionCardProps> = ({
  position,
  selectable,
  selected,
  onSelect,
}) => {
  const ltvColor =
    position.ltv >= position.liquidationLtv
      ? SEMANTIC_COLORS.danger
      : position.ltv > position.liquidationLtv - 0.1
        ? SEMANTIC_COLORS.warning
        : SEMANTIC_COLORS.textPrimary

  // Deliberately NOT a <button> wrapper: this card contains tables, and phrasing
  // content is all a button may hold. The selector is its own control in the header.
  const interactive = Boolean(selectable && onSelect)

  return (
    <Box
      bg={SEMANTIC_COLORS.bgSecondary}
      border="1px solid"
      borderColor={selected ? SEMANTIC_COLORS.success : SEMANTIC_COLORS.borderSubtle}
      borderRadius={0}
      transition={TRANSITIONS.colors}
      p={SPACING.base}
      display="grid"
      gap={SPACING.md}
    >
      <Box
        display="flex"
        justifyContent="space-between"
        alignItems="baseline"
        gap={SPACING.md}
        flexWrap="wrap"
      >
        <Box display="grid" gap="2px">
          <Text {...eyebrow}>
            {selectable ? (selected ? 'simulating this one' : 'not selected') : 'position'}
          </Text>
          <Text
            fontFamily={TYPOGRAPHY.fontDisplay}
            fontSize="clamp(17px, 2.4vw, 22px)"
            color={SEMANTIC_COLORS.textPrimary}
          >
            {position.label}
          </Text>
        </Box>
        <Box display="flex" gap={SPACING.sm} alignItems="center" flexWrap="wrap">
          {interactive && !selected && (
            <Box
              as="button"
              type="button"
              onClick={onSelect}
              aria-label={`Simulate the ${position.label} position instead`}
              bg="transparent"
              border="1px solid"
              borderColor={SEMANTIC_COLORS.borderStrong}
              color={SEMANTIC_COLORS.textPrimary}
              borderRadius={0}
              fontFamily={TYPOGRAPHY.fontMono}
              fontSize="9px"
              letterSpacing="0.16em"
              textTransform="uppercase"
              px={SPACING.sm}
              py="5px"
              cursor="pointer"
              transition={TRANSITIONS.colors}
              _hover={{ borderColor: SEMANTIC_COLORS.success, color: SEMANTIC_COLORS.success }}
              _focusVisible={FOCUS_STYLES.ring}
            >
              Simulate this one
            </Box>
          )}
          <Stamp provenance={position.provenance} />
        </Box>
      </Box>

      <Box
        display="grid"
        gridTemplateColumns="repeat(auto-fit, minmax(132px, 1fr))"
        gap="1px"
        bg={SEMANTIC_COLORS.borderSubtle}
        border="1px solid"
        borderColor={SEMANTIC_COLORS.borderSubtle}
      >
        <Metric
          label="Collateral"
          value={usd(position.totalCollateralUsd)}
          note="at the protocol's own oracle"
        />
        <Metric label="Debt" value={usd(position.totalDebtUsd)} />
        <Metric
          label="LTV"
          value={pct(position.ltv)}
          color={ltvColor}
          note={`liquidated past ${pct(position.liquidationLtv)}`}
        />
        <Metric
          label="Health factor"
          value={Number.isFinite(position.healthFactor) ? position.healthFactor.toFixed(2) : '—'}
          note="1.00 is the line"
        />
      </Box>

      {/* legs */}
      <Box display="grid" gap={SPACING.sm}>
        <Text {...HEAD}>Collateral legs</Text>
        <Box overflowX="auto">
          <Box as="table" w="100%" minW="520px" style={{ borderCollapse: 'collapse' }}>
            <Box as="thead">
              <Box as="tr">
                {[
                  'asset',
                  'amount',
                  'price',
                  'value',
                  'liq. threshold',
                  'max ltv',
                  'liq. bonus',
                ].map((h, i) => (
                  <Box
                    as="th"
                    key={h}
                    {...HEAD}
                    textAlign={i === 0 ? 'left' : 'right'}
                    py={SPACING.xs}
                    borderBottom="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    fontWeight={TYPOGRAPHY.normal}
                  >
                    {h}
                  </Box>
                ))}
              </Box>
            </Box>
            <Box as="tbody">
              {position.collateral.map((c) => (
                <Box as="tr" key={`${c.address}-${c.symbol}`}>
                  <Box as="td" {...CELL} py={SPACING.xs}>
                    {c.symbol}
                  </Box>
                  <Box as="td" {...CELL} textAlign="right" py={SPACING.xs}>
                    {amt(c.amount)}
                  </Box>
                  <Box as="td" {...CELL} textAlign="right" py={SPACING.xs}>
                    {usd(c.priceUsd)}
                  </Box>
                  <Box as="td" {...CELL} textAlign="right" py={SPACING.xs}>
                    {usd(c.valueUsd)}
                  </Box>
                  <Box as="td" {...CELL} textAlign="right" py={SPACING.xs}>
                    {pct(c.liquidationThreshold)}
                  </Box>
                  <Box as="td" {...CELL} textAlign="right" py={SPACING.xs}>
                    {pct(c.maxLtv)}
                  </Box>
                  <Box
                    as="td"
                    {...CELL}
                    textAlign="right"
                    py={SPACING.xs}
                    color={
                      c.liquidationBonus === null
                        ? SEMANTIC_COLORS.textTertiary
                        : SEMANTIC_COLORS.textPrimary
                    }
                  >
                    {c.liquidationBonus === null ? 'not exposed' : pct(c.liquidationBonus)}
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>

        <Text {...HEAD} mt={SPACING.sm}>
          Debt legs
        </Text>
        <Box overflowX="auto">
          <Box as="table" w="100%" minW="360px" style={{ borderCollapse: 'collapse' }}>
            <Box as="thead">
              <Box as="tr">
                {['asset', 'amount', 'value', 'borrow apr'].map((h, i) => (
                  <Box
                    as="th"
                    key={h}
                    {...HEAD}
                    textAlign={i === 0 ? 'left' : 'right'}
                    py={SPACING.xs}
                    borderBottom="1px solid"
                    borderColor={SEMANTIC_COLORS.borderSubtle}
                    fontWeight={TYPOGRAPHY.normal}
                  >
                    {h}
                  </Box>
                ))}
              </Box>
            </Box>
            <Box as="tbody">
              {position.debt.map((d) => (
                <Box as="tr" key={`${d.address}-${d.symbol}`}>
                  <Box as="td" {...CELL} py={SPACING.xs}>
                    {d.symbol}
                  </Box>
                  <Box as="td" {...CELL} textAlign="right" py={SPACING.xs}>
                    {amt(d.amount)}
                  </Box>
                  <Box as="td" {...CELL} textAlign="right" py={SPACING.xs}>
                    {usd(d.valueUsd)}
                  </Box>
                  <Box
                    as="td"
                    {...CELL}
                    textAlign="right"
                    py={SPACING.xs}
                    color={
                      d.borrowApr === null
                        ? SEMANTIC_COLORS.textTertiary
                        : SEMANTIC_COLORS.textPrimary
                    }
                  >
                    {d.borrowApr === null ? 'not exposed' : pct(d.borrowApr, 2)}
                  </Box>
                </Box>
              ))}
            </Box>
          </Box>
        </Box>
        <Text {...monoXs} lineHeight={1.7}>
          The borrow rate is shown only where the protocol exposes one. The run below holds every
          debt balance at its opening size across the window: the simulator does not accrue borrow
          interest, so the two engines are compared on the price move alone. Real debt keeps growing
          in both of them.
        </Text>
      </Box>
    </Box>
  )
}

export default PositionCard
