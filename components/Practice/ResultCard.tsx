import React from 'react'
import { Box, SimpleGrid, Text } from '@chakra-ui/react'

import { SEMANTIC_COLORS } from '@/config/semanticColors'
import { SPACING } from '@/config/spacing'
import { TYPOGRAPHY } from '@/helpers/typography'
import {
  clockAt,
  fmtPct,
  fmtUsd,
  type Baseline,
  type LiquidatorResult,
  type PracticeState,
  type Score,
} from '@/lib/practice/engine'

import { Eyebrow, Fact, Panel } from './atoms'
import { choiceLabel } from './PauseSheet'
import { PriceStrip } from './PriceStrip'

const Column: React.FC<{
  title: string
  keptUsd: number
  keptPct: number
  countLabel: string
  count: number
  takenLabel: string
  takenUsd: number
  extra?: React.ReactNode
  highlight?: boolean
}> = ({ title, keptUsd, keptPct, countLabel, count, takenLabel, takenUsd, extra, highlight }) => (
  <Panel accent={highlight ? SEMANTIC_COLORS.borderStrong : undefined}>
    <Eyebrow color={highlight ? SEMANTIC_COLORS.textPrimary : undefined}>{title}</Eyebrow>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="28px" color={SEMANTIC_COLORS.textPrimary} mt={SPACING.sm}>
      {fmtPct(keptPct)}
    </Text>
    <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary}>
      collateral kept · {fmtUsd(keptUsd)}
    </Text>
    <SimpleGrid columns={2} spacing={SPACING.sm} mt={SPACING.md}>
      <Fact label={countLabel} value={count} />
      <Fact label={takenLabel} value={fmtUsd(takenUsd)} color={takenUsd > 0 ? SEMANTIC_COLORS.danger : undefined} />
    </SimpleGrid>
    {extra}
  </Panel>
)

export const ResultCard: React.FC<{
  st: PracticeState
  you: Score
  baseline: Baseline
  liquidators: LiquidatorResult | null
  tapeName: string
}> = ({ st, you, baseline, liquidators, tapeName }) => {
  const sc = st.sc
  const cure = baseline.cure
  return (
    <Box>
      <SimpleGrid columns={{ base: 1, md: liquidators ? 3 : 2 }} spacing={SPACING.md}>
        <Column
          title="You"
          highlight
          keptUsd={you.collateralKeptUsd}
          keptPct={you.collateralKeptPct}
          countLabel="sales"
          count={you.sales}
          takenLabel="sold"
          takenUsd={you.soldUsd}
          extra={
            you.addedUsd > 0 || you.repaidUsd > 0 ? (
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.sm}>
                you put in {fmtUsd(you.addedUsd)} collateral · {fmtUsd(you.repaidUsd)} repaid
              </Text>
            ) : null
          }
        />
        <Column
          title="Membrane, no action"
          keptUsd={baseline.score.collateralKeptUsd}
          keptPct={baseline.score.collateralKeptPct}
          countLabel="sales"
          count={cure ? cure.sales : baseline.score.sales}
          takenLabel="sold"
          takenUsd={cure ? cure.closedUsd : baseline.score.soldUsd}
        />
        {liquidators && (
          <Column
            title="What liquidators took"
            keptUsd={liquidators.collateralKeptUsd}
            keptPct={liquidators.collateralKeptPct}
            countLabel="liquidations"
            count={liquidators.liquidations}
            takenLabel="seized"
            takenUsd={liquidators.seizedUsd}
            extra={
              <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="11px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.sm}>
                Aave-style at the same {fmtPct(sc.line)} line: repays {liquidators.repayFractionLabel}, plus a{' '}
                {fmtPct(liquidators.bonus, 0)} bonus. No window.
              </Text>
            }
          />
        )}
      </SimpleGrid>

      <Box mt={SPACING.lg}>
        <PriceStrip sc={sc} upTo={st.index} sales={st.sales} choices={st.choices} />
      </Box>

      {st.choices.length > 0 && (
        <Box mt={SPACING.md}>
          {st.choices.map((c, k) => (
            <Text key={k} fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.textSecondary} lineHeight={1.8}>
              {clockAt(sc, c.index)} · {choiceLabel(c.choice)} · {fmtUsd(c.usd)} · {fmtPct(c.ltvBefore, 2)} → {fmtPct(c.ltvAfter, 2)}
            </Text>
          ))}
        </Box>
      )}
      {st.sales.map((s, k) => (
        <Text key={`s${k}`} fontFamily={TYPOGRAPHY.fontMono} fontSize="12px" color={SEMANTIC_COLORS.danger} lineHeight={1.8}>
          {clockAt(sc, s.index)} · sold {fmtUsd(s.seizedUsd)} at {fmtPct(s.ltvBefore, 2)} ·{' '}
          {s.reason === 'band' ? 'passed the break line' : 'window expired'}
        </Text>
      ))}

      <Text fontFamily={TYPOGRAPHY.fontMono} fontSize="10px" color={SEMANTIC_COLORS.textTertiary} mt={SPACING.md} lineHeight={1.7}>
        Same position, same prices: {tapeName}. Kept % = collateral still held ÷ all collateral posted, priced at the last minute.
      </Text>
    </Box>
  )
}
