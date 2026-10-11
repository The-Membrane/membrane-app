// THE NET BREAKDOWN ROWS — presentational only. Extracted from NetApyCard so a precomputed
// NetBreakdown (the carry scout stores one per on-chain priced row) renders exactly like a
// live one. No fetching here: pass the rows.
//
// HONESTY RULES (same as NetApyCard): a row whose value is curator-set and not given reads
// "curator-set", and a ceiling reads "≤". Never 0%, $0 or "free". Every row carries its
// label class (lib/netApy/types.ts LabelClass).

import React from 'react'
import { Box, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import type { BreakdownRow } from '@/lib/netApy/breakdown'
import type { LabelClass } from '@/lib/netApy/types'

export const CLASS_COLOR: Record<LabelClass, string> = {
  measured: SEMANTIC_COLORS.info,
  derived: SEMANTIC_COLORS.textSecondary,
  projected: SEMANTIC_COLORS.warning,
  reported: SEMANTIC_COLORS.textSecondary,
  'curator-set': SEMANTIC_COLORS.textSecondary,
}

/** Fraction → "4.37%", real minus sign. */
export const pct = (v: number | null | undefined, dp = 2): string => {
  if (v === null || v === undefined || !Number.isFinite(v)) return '—'
  const s = `${(Math.abs(v) * 100).toFixed(dp)}%`
  return v < 0 ? `−${s}` : s
}

export const ClassTag: React.FC<{ c: LabelClass }> = ({ c }) => (
  <Text
    as="span"
    data-label-class={c}
    fontFamily={TYPOGRAPHY.fontMono}
    fontSize="8.5px"
    letterSpacing="0.14em"
    textTransform="uppercase"
    color={CLASS_COLOR[c]}
  >
    {c}
  </Text>
)

/** The fields a row renderer reads; a serialized NetBreakdown row satisfies it. */
export type BreakdownRowLike = Pick<
  BreakdownRow,
  'key' | 'label' | 'op' | 'apr' | 'bound' | 'note'
> & { labelClass: LabelClass | string }

export interface BreakdownRowsProps {
  rows: readonly BreakdownRowLike[]
  mt?: string
}

/** op · label · value · claim class. Rows are APR (additive); a headline APY is the net compounded. */
export const BreakdownRows: React.FC<BreakdownRowsProps> = ({ rows, mt = SPACING.sm }) => (
  <Box
    as="dl"
    mt={mt}
    display="grid"
    gridTemplateColumns="14px 1fr auto auto"
    columnGap={SPACING.sm}
    rowGap="2px"
    alignItems="baseline"
  >
    <Box as="span" />
    <Box as="span" />
    <Text
      as="span"
      fontFamily={TYPOGRAPHY.fontMono}
      fontSize="8.5px"
      letterSpacing="0.14em"
      textAlign="right"
      color={SEMANTIC_COLORS.textTertiary}
    >
      APR
    </Text>
    <Box as="span" />
    {rows.map((r) => (
      <React.Fragment key={r.key}>
        <Text
          as="span"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          color={SEMANTIC_COLORS.textTertiary}
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {r.op}
        </Text>
        <Text
          as="dt"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          color={r.op === '=' ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
          title={r.note}
        >
          {r.label}
        </Text>
        <Text
          as="dd"
          fontFamily={TYPOGRAPHY.fontMono}
          fontSize="11px"
          textAlign="right"
          color={r.op === '=' ? SEMANTIC_COLORS.textPrimary : SEMANTIC_COLORS.textSecondary}
          sx={{ fontVariantNumeric: 'tabular-nums' }}
        >
          {r.apr === null ? 'curator-set' : `${r.bound === 'upper' ? '≤ ' : ''}${pct(r.apr)}`}
        </Text>
        <ClassTag c={r.labelClass as LabelClass} />
      </React.Fragment>
    ))}
  </Box>
)

export default BreakdownRows
